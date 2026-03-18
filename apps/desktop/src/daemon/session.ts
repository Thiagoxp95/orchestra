import { spawn, ChildProcess, execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import * as net from 'node:net'
import { HeadlessEmulator } from './headless-emulator'
import { HistoryWriter } from './history-writer'
import {
  PtyMessageType, writeFrame, createFrameParser,
  SpawnMessage, SessionSnapshot, sendJson
} from './protocol'
import { PromptHistoryWriter } from './prompt-history-writer'
import { buildCliChildEnv, buildNodeChildEnv, buildShellChildEnv, resolveCommandExecPath, resolveNodeExecPath } from '../main/node-runtime'
import { shellQuote } from '../shared/action-utils'
import type { TerminalLaunchProfile } from '../shared/types'

let cachedShouldForceNativeArm64Shell: boolean | null = null

function getUserShell(): string {
  if (process.env.SHELL && existsSync(process.env.SHELL)) {
    return process.env.SHELL
  }

  if (process.platform !== 'win32') {
    try {
      const result = execFileSync('dscl', ['.', '-read', `/Users/${process.env.USER}`, 'UserShell'], {
        encoding: 'utf8',
        timeout: 3000
      })
      const match = result.match(/UserShell:\s*(.+)/)
      if (match && existsSync(match[1].trim())) {
        return match[1].trim()
      }
    } catch {
      try {
        const passwd = execFileSync('getent', ['passwd', process.env.USER || process.env.LOGNAME || ''], {
          encoding: 'utf8',
          timeout: 3000
        })
        const shell = passwd.trim().split(':').pop()
        if (shell && existsSync(shell)) {
          return shell
        }
      } catch {}
    }
  }

  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe'
  }

  for (const sh of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (existsSync(sh)) return sh
  }

  return '/bin/sh'
}

export function getShellSpawnArgs(
  _shellPath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (platform === 'win32') return []

  const args = ['-i']
  if (env.ORCHESTRA_LOGIN_SHELL === '1') {
    args.push('-l')
  }
  return args
}

export function canSendInitialCommand(
  launchProfile: TerminalLaunchProfile | undefined,
  ptyPid: number | null,
  shellReady: boolean
): boolean {
  if (ptyPid == null) return false
  if (launchProfile?.kind === 'exec') return true
  return shellReady
}

export function buildShellEnvBootstrapCommand(env: Record<string, string | undefined>): string {
  const entries = Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] != null)
    .sort(([left], [right]) => left.localeCompare(right))

  return entries
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('; ')
}

function shouldForceNativeArm64Shell(): boolean {
  if (cachedShouldForceNativeArm64Shell != null) {
    return cachedShouldForceNativeArm64Shell
  }

  if (process.platform !== 'darwin' || process.arch !== 'x64') {
    cachedShouldForceNativeArm64Shell = false
    return false
  }

  try {
    cachedShouldForceNativeArm64Shell = execFileSync('sysctl', ['-in', 'sysctl.proc_translated'], {
      encoding: 'utf8',
      timeout: 1000,
    }).trim() === '1'
  } catch {
    cachedShouldForceNativeArm64Shell = false
  }

  return cachedShouldForceNativeArm64Shell
}

function resolveLaunchTarget(
  launchProfile: TerminalLaunchProfile | undefined,
  env?: Record<string, string>
): { file: string; args: string[]; env: Record<string, string> } {
  if (launchProfile?.kind === 'exec') {
    return {
      file: resolveCommandExecPath(launchProfile.file) || launchProfile.file,
      args: launchProfile.args || [],
      env: buildCliChildEnv({ ...(env || {}), ...(launchProfile.env || {}) }) as Record<string, string>,
    }
  }

  const shell = getUserShell()
  const shellEnv = buildShellChildEnv({ ...(env || {}), SHELL: shell }) as Record<string, string>
  const shellArgs = getShellSpawnArgs(shell, process.platform, shellEnv)

  if (shouldForceNativeArm64Shell()) {
    return {
      file: '/usr/bin/arch',
      args: ['-arm64', shell, ...shellArgs],
      env: shellEnv,
    }
  }

  return {
    file: shell,
    args: shellArgs,
    env: shellEnv,
  }
}

export interface SessionOptions {
  sessionId: string
  cols: number
  rows: number
  cwd: string
  env?: Record<string, string>
  shell?: string
  initialCommand?: string
  launchProfile?: TerminalLaunchProfile
  persistHistory?: boolean
  suppressSessionIdEnv?: boolean
}

export class Session {
  private static readonly SHELL_READY_DELAY_MS = 120

  sessionId: string
  private subprocess: ChildProcess | null = null
  private emulator: HeadlessEmulator
  private historyWriter: HistoryWriter | null = null
  private promptHistoryWriter: PromptHistoryWriter | null = null
  private ptyPid: number | null = null
  private exitCode: number | null = null
  private terminatingAt: Date | null = null
  private disposed = false
  private initialCommand: string | undefined
  private initialCommandSent = false
  private launchProfile: TerminalLaunchProfile | undefined
  private cwd: string
  private cols: number
  private rows: number
  private shellReady = false
  private shellReadyTimer: ReturnType<typeof setTimeout> | null = null
  private claimedShellEnv: Record<string, string> | null = null
  private suppressSessionIdEnv = false

  private streamClients = new Set<net.Socket>()
  private onExitCallback: ((sessionId: string, exitCode: number, signal: number) => void) | null = null

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.cols = opts.cols
    this.rows = opts.rows
    this.emulator = new HeadlessEmulator(opts.cols, opts.rows, opts.cwd)
    this.initialCommand = opts.initialCommand
    this.launchProfile = opts.launchProfile
    this.shellReady = opts.launchProfile?.kind === 'exec'
    this.suppressSessionIdEnv = opts.suppressSessionIdEnv === true
    if (opts.persistHistory !== false) {
      this.enablePersistence()
    }
  }

  get isAlive(): boolean {
    return this.subprocess !== null && this.exitCode === null
  }

  get isTerminating(): boolean {
    return this.terminatingAt !== null
  }

  get isAttachable(): boolean {
    return this.isAlive && !this.isTerminating
  }

  get isReadyForReuse(): boolean {
    return this.isAttachable && this.shellReady
  }

  get pid(): number | null {
    return this.ptyPid
  }

  get clientCount(): number {
    return this.streamClients.size
  }

  onExit(cb: (sessionId: string, exitCode: number, signal: number) => void): void {
    this.onExitCallback = cb
  }

  claim(opts: {
    sessionId: string
    cwd: string
    cols: number
    rows: number
    env?: Record<string, string>
    initialCommand?: string
    launchProfile?: TerminalLaunchProfile
  }): void {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.cols = opts.cols
    this.rows = opts.rows
    this.initialCommand = opts.initialCommand
    this.initialCommandSent = false
    this.launchProfile = opts.launchProfile
    this.claimedShellEnv = opts.launchProfile?.kind === 'exec'
      ? null
      : {
          ...(opts.env || {}),
          ORCHESTRA_SESSION_ID: opts.sessionId,
        }
    if (opts.launchProfile?.kind === 'exec') {
      this.shellReady = true
    }
    this.enablePersistence()
    this.resize(opts.cols, opts.rows)
    this.flushStartupCommandsIfNeeded()
  }

  private enablePersistence(): void {
    if (this.historyWriter && this.promptHistoryWriter) return
    this.historyWriter = new HistoryWriter(this.sessionId, this.cwd, this.cols, this.rows)
    this.promptHistoryWriter = new PromptHistoryWriter(this.sessionId)
    this.historyWriter.open()
    this.promptHistoryWriter.open()
  }

  private closePersistence(exitCode?: number): void {
    this.historyWriter?.close(exitCode)
    this.promptHistoryWriter?.close()
  }

  private clearShellReadyTimer(): void {
    if (this.shellReadyTimer) {
      clearTimeout(this.shellReadyTimer)
      this.shellReadyTimer = null
    }
  }

  private scheduleShellReady(): void {
    if (this.launchProfile?.kind === 'exec' || this.shellReady) return
    this.clearShellReadyTimer()
    this.shellReadyTimer = setTimeout(() => {
      this.shellReadyTimer = null
      this.shellReady = true
      this.flushStartupCommandsIfNeeded()
    }, Session.SHELL_READY_DELAY_MS)
  }

  private flushStartupCommandsIfNeeded(): void {
    if (!this.claimedShellEnv && (this.initialCommand == null || this.initialCommandSent)) return
    if (!canSendInitialCommand(this.launchProfile, this.ptyPid, this.shellReady)) return

    if (this.claimedShellEnv) {
      const bootstrap = buildShellEnvBootstrapCommand(this.claimedShellEnv)
      this.claimedShellEnv = null
      if (bootstrap) {
        this.writeHiddenCommand(bootstrap)
      }
    }

    if (this.initialCommand && !this.initialCommandSent) {
      this.initialCommandSent = true
      this.write(this.initialCommand + '\n', 'system')
    }
  }

  private writeHiddenCommand(command: string): void {
    if (!this.subprocess?.stdin) return
    writeFrame(this.subprocess.stdin, PtyMessageType.Write, Buffer.from(command + '\n', 'utf8'))
  }

  spawn(opts: { cwd: string; cols: number; rows: number; env?: Record<string, string> }): void {
    if (this.subprocess) throw new Error('PTY already spawned')

    const subprocessPath = join(__dirname, 'pty-subprocess.js')
    const nodeExecPath = resolveNodeExecPath()

    this.subprocess = spawn(nodeExecPath, [subprocessPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: buildNodeChildEnv({ ORCHESTRA_NODE_EXEC_PATH: nodeExecPath })
    })

    this.subprocess.on('error', (err) => {
      console.error(`[Session ${this.sessionId}] Subprocess spawn error: ${err.message}`)
      this.exitCode = -1
      this.subprocess = null
      this.onExitCallback?.(this.sessionId, -1, 0)
    })

    const parseFrame = createFrameParser((type, payload) => {
      switch (type) {
        case PtyMessageType.Ready: {
          const target = resolveLaunchTarget(this.launchProfile, {
            ...(opts.env || {}),
            ...(this.suppressSessionIdEnv ? {} : { ORCHESTRA_SESSION_ID: this.sessionId }),
          })
          const msg: SpawnMessage = {
            file: target.file,
            args: target.args,
            cwd: opts.cwd,
            cols: opts.cols,
            rows: opts.rows,
            env: target.env
          }
          writeFrame(this.subprocess!.stdin!, PtyMessageType.Spawn, Buffer.from(JSON.stringify(msg)))
          break
        }

        case PtyMessageType.Spawned: {
          this.ptyPid = payload.readUInt32LE(0)
          this.flushStartupCommandsIfNeeded()
          break
        }

        case PtyMessageType.Data: {
          const data = payload.toString('utf8')
          if (this.launchProfile?.kind !== 'exec' && !this.shellReady) {
            this.scheduleShellReady()
          }
          this.emulator.write(data)
          this.historyWriter?.write(data)
          for (const client of this.streamClients) {
            sendJson(client, {
              type: 'event',
              event: 'data',
              sessionId: this.sessionId,
              data
            })
          }
          break
        }

        case PtyMessageType.Exit: {
          const exitCode = payload.readInt32LE(0)
          const signal = payload.readInt32LE(4)
          this.exitCode = exitCode
          this.subprocess = null
          this.ptyPid = null
          this.shellReady = false
          this.claimedShellEnv = null

          this.clearShellReadyTimer()
          this.closePersistence(exitCode)
          for (const client of this.streamClients) {
            sendJson(client, {
              type: 'event',
              event: 'exit',
              sessionId: this.sessionId,
              exitCode,
              signal
            })
          }
          this.onExitCallback?.(this.sessionId, exitCode, signal)
          break
        }

        case PtyMessageType.Error: {
          console.error(`[Session ${this.sessionId}] PTY error: ${payload.toString('utf8')}`)
          break
        }
      }
    })

    this.subprocess.stdout!.on('data', (chunk: Buffer) => parseFrame(chunk))

    this.subprocess.on('exit', () => {
      if (this.exitCode === null) {
        this.exitCode = -1
        this.subprocess = null
        this.shellReady = false
        this.clearShellReadyTimer()
        this.closePersistence(-1)
        this.onExitCallback?.(this.sessionId, -1, 0)
      }
    })
  }

  write(data: string, source: 'user' | 'system' = 'user'): void {
    if (!this.subprocess?.stdin) return
    writeFrame(this.subprocess.stdin, PtyMessageType.Write, Buffer.from(data, 'utf8'))
    if (source === 'user') {
      const submittedText = this.promptHistoryWriter?.feedUserInput(data)
      if (submittedText) {
        for (const client of this.streamClients) {
          sendJson(client, {
            type: 'event',
            event: 'prompt',
            sessionId: this.sessionId,
            text: submittedText
          })
        }
      }
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    if (this.subprocess?.stdin) {
      const buf = Buffer.alloc(8)
      buf.writeUInt32LE(cols, 0)
      buf.writeUInt32LE(rows, 4)
      writeFrame(this.subprocess.stdin, PtyMessageType.Resize, buf)
    }
    this.emulator.resize(cols, rows)
    this.historyWriter?.updateDimensions(cols, rows)
  }

  async attach(socket: net.Socket): Promise<SessionSnapshot> {
    this.streamClients.add(socket)
    this.emulator.setHasClients(true)
    return this.emulator.getSnapshotAsync()
  }

  detach(socket: net.Socket): void {
    this.streamClients.delete(socket)
    if (this.streamClients.size === 0) {
      this.emulator.setHasClients(false)
    }
  }

  kill(signal = 'SIGTERM'): void {
    if (this.terminatingAt) return
    this.terminatingAt = new Date()
    if (this.subprocess?.stdin) {
      writeFrame(this.subprocess.stdin, PtyMessageType.Kill, Buffer.from(signal))
    }
  }

  sendSignal(signal: string): void {
    if (this.terminatingAt || !this.subprocess?.stdin) return
    writeFrame(this.subprocess.stdin, PtyMessageType.Signal, Buffer.from(signal))
  }

  getSnapshot(): SessionSnapshot {
    return this.emulator.getSnapshot()
  }

  async getSnapshotAsync(): Promise<SessionSnapshot> {
    return this.emulator.getSnapshotAsync()
  }

  getMeta(): { sessionId: string; pid: number | null; cwd: string; isAlive: boolean } {
    return {
      sessionId: this.sessionId,
      pid: this.ptyPid,
      cwd: this.emulator.getCwd(),
      isAlive: this.isAttachable
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.subprocess?.stdin) {
      writeFrame(this.subprocess.stdin, PtyMessageType.Dispose, Buffer.alloc(0))
    }
    this.clearShellReadyTimer()
    this.claimedShellEnv = null
    this.emulator.dispose()
    this.closePersistence()
    this.streamClients.clear()
  }

  cleanupHistory(): void {
    this.historyWriter?.cleanup()
  }
}
