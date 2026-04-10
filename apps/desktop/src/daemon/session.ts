import { spawn, ChildProcess, execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import * as net from 'node:net'
import { HeadlessEmulator } from './headless-emulator'
import { HistoryWriter } from './history-writer'
import { buildSyntheticTerminalResponses } from './terminal-query-responder'
import {
  PtyMessageType, writeFrame, createFrameParser,
  SpawnMessage, SessionSnapshot, sendJson
} from './protocol'
import { PromptHistoryWriter } from './prompt-history-writer'
import { buildCliChildEnv, buildNodeChildEnv, buildShellChildEnv, resolveCommandExecPath, resolveNodeExecPath } from '../main/node-runtime'
import { readHookPortFile } from '../main/hook-port-file'
import {
  CLAUDE_INTERACTIVE_COMMAND_PREVIEW,
  CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW,
  CODEX_INTERACTIVE_COMMAND_PREVIEW,
  CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW,
  shellQuote,
} from '../shared/action-utils'
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

export function getResumeInitialCommand(initialCommand?: string): string | undefined {
  if (!initialCommand) return undefined

  if (
    initialCommand === CLAUDE_INTERACTIVE_COMMAND_PREVIEW
    || initialCommand.startsWith(`${CLAUDE_INTERACTIVE_COMMAND_PREVIEW} `)
  ) {
    return CLAUDE_INTERACTIVE_COMMAND_PREVIEW
  }

  if (
    initialCommand === CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW
    || initialCommand.startsWith(`${CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW} `)
  ) {
    return CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW
  }

  if (
    initialCommand === CODEX_INTERACTIVE_COMMAND_PREVIEW
    || initialCommand.startsWith(`${CODEX_INTERACTIVE_COMMAND_PREVIEW} `)
  ) {
    return CODEX_INTERACTIVE_COMMAND_PREVIEW
  }

  if (
    initialCommand === CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW
    || initialCommand.startsWith(`${CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW} `)
  ) {
    return CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW
  }

  return initialCommand
}

export function getClaimDimensions(
  reuseRunningProcess: boolean | undefined,
  requested: { cols: number; rows: number },
  current: { cols: number; rows: number }
): { cols: number; rows: number } {
  return reuseRunningProcess ? current : requested
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
  processSessionId?: string
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

// Compute env vars Orchestra injects into every spawned child.
// Reads the hook-server port from the shared file written by main on startup.
// If the port file is missing, ORCHESTRA_HOOK_PORT is omitted — hook helper
// scripts early-exit when the var isn't set, so this degrades gracefully.
//
// `env` is forwarded to readHookPortFile so callers (and tests) can scope
// the lookup to a specific HOME.
export function orchestraChildEnv(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = { ORCHESTRA_SESSION_ID: sessionId }
  const port = readHookPortFile(env)
  if (port) out.ORCHESTRA_HOOK_PORT = String(port)
  return out
}

export class Session {
  private static readonly SHELL_READY_DELAY_MS = 120

  sessionId: string
  private processSessionId: string
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
  private runtimeEnv: Record<string, string> | undefined
  private cwd: string
  private cols: number
  private rows: number
  private resumeInitialCommand: string | undefined
  private shellReady = false
  private shellReadyTimer: ReturnType<typeof setTimeout> | null = null
  private claimedShellEnv: Record<string, string> | null = null
  private suppressSessionIdEnv = false
  private suspended = false
  private suppressNextExitEvent = false

  private streamClients = new Set<net.Socket>()
  private onExitCallback: ((sessionId: string, exitCode: number, signal: number) => void) | null = null

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId
    this.processSessionId = opts.processSessionId ?? opts.sessionId
    this.cwd = opts.cwd
    this.cols = opts.cols
    this.rows = opts.rows
    this.emulator = new HeadlessEmulator(opts.cols, opts.rows, opts.cwd)
    this.initialCommand = opts.initialCommand
    this.resumeInitialCommand = getResumeInitialCommand(opts.initialCommand)
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

  get isSuspended(): boolean {
    return this.suspended
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

  get runtimeSessionId(): string {
    return this.sessionId
  }

  get envSessionId(): string {
    return this.processSessionId
  }

  get clientCount(): number {
    return this.streamClients.size
  }

  onExit(cb: (sessionId: string, exitCode: number, signal: number) => void): void {
    this.onExitCallback = cb
  }

  claim(opts: {
    sessionId: string
    processSessionId?: string
    cwd: string
    cols: number
    rows: number
    env?: Record<string, string>
    initialCommand?: string
    launchProfile?: TerminalLaunchProfile
    reuseRunningProcess?: boolean
  }): void {
    const claimDimensions = getClaimDimensions(
      opts.reuseRunningProcess,
      { cols: opts.cols, rows: opts.rows },
      this.emulator.getDimensions()
    )
    this.sessionId = opts.sessionId
    this.processSessionId = opts.processSessionId ?? opts.sessionId
    this.cwd = opts.cwd
    this.cols = claimDimensions.cols
    this.rows = claimDimensions.rows
    this.launchProfile = opts.launchProfile
    this.runtimeEnv = opts.env
    this.initialCommand = opts.reuseRunningProcess ? undefined : opts.initialCommand
    if (!opts.reuseRunningProcess) {
      this.resumeInitialCommand = getResumeInitialCommand(opts.initialCommand)
    }
    this.initialCommandSent = opts.reuseRunningProcess
      ? true
      : opts.initialCommand == null
    this.suspended = false
    this.suppressNextExitEvent = false
    this.exitCode = null
    this.terminatingAt = null
    this.claimedShellEnv = opts.reuseRunningProcess || opts.launchProfile?.kind === 'exec'
      ? null
      : {
          ...(opts.env || {}),
          ...orchestraChildEnv(this.processSessionId),
        }
    if (!opts.reuseRunningProcess && opts.launchProfile?.kind === 'exec') {
      this.shellReady = true
    }
    this.enablePersistence()
    if (!opts.reuseRunningProcess) {
      this.resize(opts.cols, opts.rows)
    }
    if (!opts.reuseRunningProcess) {
      this.flushStartupCommandsIfNeeded()
    }
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
    this.historyWriter = null
    this.promptHistoryWriter = null
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
    this.writeHiddenData(command + '\n')
  }

  private writeHiddenData(data: string): void {
    if (!this.subprocess?.stdin) return
    writeFrame(this.subprocess.stdin, PtyMessageType.Write, Buffer.from(data, 'utf8'))
  }

  spawn(opts: { cwd: string; cols: number; rows: number; env?: Record<string, string> }): void {
    if (this.subprocess) throw new Error('PTY already spawned')
    this.runtimeEnv = opts.env
    this.suspended = false
    this.exitCode = null
    this.terminatingAt = null

    const subprocessPath = join(__dirname, 'pty-subprocess.js')
    const nodeExecPath = resolveNodeExecPath()

    this.subprocess = spawn(nodeExecPath, [subprocessPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: buildNodeChildEnv({ ORCHESTRA_NODE_EXEC_PATH: nodeExecPath })
    })

    this.subprocess.on('error', (err) => {
      console.error(`[Session ${this.sessionId}] Subprocess spawn error: ${err.message}`)
      this.exitCode = -1
      this.destroySubprocess()
      this.onExitCallback?.(this.sessionId, -1, 0)
    })

    const parseFrame = createFrameParser((type, payload) => {
      switch (type) {
        case PtyMessageType.Ready: {
          const target = resolveLaunchTarget(this.launchProfile, {
            ...(opts.env || {}),
            ...(this.suppressSessionIdEnv ? {} : orchestraChildEnv(this.processSessionId)),
          })
          let cwd = opts.cwd
          if (!existsSync(cwd)) {
            console.warn(`[Session ${this.sessionId}] cwd does not exist: ${cwd}, falling back to home`)
            cwd = process.env.HOME || '/'
          }
          const msg: SpawnMessage = {
            file: target.file,
            args: target.args,
            cwd,
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
          if (this.streamClients.size === 0) {
            const syntheticResponse = buildSyntheticTerminalResponses(data)
            if (syntheticResponse) {
              this.writeHiddenData(syntheticResponse)
            }
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
          this.destroySubprocess()
          this.ptyPid = null
          this.shellReady = false
          this.claimedShellEnv = null

          this.clearShellReadyTimer()
          this.closePersistence(exitCode)
          if (this.suppressNextExitEvent) {
            this.suppressNextExitEvent = false
            this.suspended = true
            this.exitCode = null
            this.terminatingAt = null
            return
          }
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
          const errorText = payload.toString('utf8')
          console.error(`[Session ${this.sessionId}] PTY error: ${errorText}`)
          // Forward error to stream clients so xterm.js displays it
          for (const client of this.streamClients) {
            sendJson(client, {
              type: 'event',
              event: 'data',
              sessionId: this.sessionId,
              data: `\r\n\x1b[31m[orchestra] ${errorText}\x1b[0m\r\n`
            })
          }
          break
        }
      }
    })

    this.subprocess.stdout!.on('data', (chunk: Buffer) => parseFrame(chunk))

    this.subprocess.on('exit', () => {
      if (this.exitCode === null) {
        this.exitCode = -1
        this.destroySubprocess()
        this.shellReady = false
        this.clearShellReadyTimer()
        this.closePersistence(-1)
        if (this.suppressNextExitEvent) {
          this.suppressNextExitEvent = false
          this.suspended = true
          this.exitCode = null
          this.terminatingAt = null
          return
        }
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

  /**
   * Tear down the pty-subprocess.js wrapper process.
   * Sends a Dispose frame (clean shutdown), destroys the stdin pipe,
   * and SIGKILL's the process as a belt-and-suspenders fallback.
   * Idempotent — safe to call multiple times.
   */
  private destroySubprocess(): void {
    const sub = this.subprocess
    if (!sub) return
    this.subprocess = null

    // Remove listeners to prevent double-fire / prevent the ChildProcess
    // reference from being held by the event loop.
    sub.stdout?.removeAllListeners('data')
    sub.removeAllListeners('exit')

    // Ask subprocess to exit cleanly (it calls process.exit(0))
    if (sub.stdin && !sub.stdin.destroyed) {
      try {
        writeFrame(sub.stdin, PtyMessageType.Dispose, Buffer.alloc(0))
      } catch {}
      sub.stdin.destroy()
    }

    // Direct OS kill as fallback
    try { sub.kill('SIGKILL') } catch {}
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

  getMeta(): { sessionId: string; processSessionId: string; pid: number | null; cwd: string; isAlive: boolean } {
    return {
      sessionId: this.sessionId,
      pid: this.ptyPid,
      cwd: this.emulator.getCwd(),
      isAlive: this.isAttachable,
      processSessionId: this.processSessionId,
    }
  }

  suspend(): void {
    if (this.suspended || !this.isAlive || !this.subprocess?.stdin) return
    this.suppressNextExitEvent = true
    this.terminatingAt = new Date()
    writeFrame(this.subprocess.stdin, PtyMessageType.Kill, Buffer.from('SIGTERM'))
  }

  resume(): void {
    if (!this.suspended) return
    this.initialCommand = this.resumeInitialCommand
    this.initialCommandSent = this.initialCommand == null
    this.claimedShellEnv = this.launchProfile?.kind === 'exec'
      ? null
      : {
          ...(this.runtimeEnv || {}),
          ...(this.suppressSessionIdEnv ? {} : orchestraChildEnv(this.processSessionId)),
        }
    this.shellReady = this.launchProfile?.kind === 'exec'
    this.clearShellReadyTimer()
    this.enablePersistence()
    this.spawn({
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      env: this.runtimeEnv,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.destroySubprocess()
    this.clearShellReadyTimer()
    this.claimedShellEnv = null
    this.emulator.dispose()
    this.closePersistence()
    this.streamClients.clear()
  }

  cleanupHistory(): void {
    HistoryWriter.cleanupSession(this.sessionId)
  }
}
