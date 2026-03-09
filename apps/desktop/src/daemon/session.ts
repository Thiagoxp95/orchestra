// src/daemon/session.ts
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

function getUserShell(): string {
  // 1. Respect SHELL env var if set
  if (process.env.SHELL && existsSync(process.env.SHELL)) {
    return process.env.SHELL
  }

  // 2. On macOS/Linux, query the system for the user's default shell
  if (process.platform !== 'win32') {
    try {
      // dscl works on macOS
      const result = execFileSync('dscl', ['.', '-read', `/Users/${process.env.USER}`, 'UserShell'], {
        encoding: 'utf8',
        timeout: 3000
      })
      const match = result.match(/UserShell:\s*(.+)/)
      if (match && existsSync(match[1].trim())) {
        return match[1].trim()
      }
    } catch {
      // Not macOS or dscl failed — try getent (Linux)
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

  // 3. Platform-specific fallbacks
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe'
  }

  // Try common shells in order of preference
  for (const sh of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (existsSync(sh)) return sh
  }

  return '/bin/sh'
}

export interface SessionOptions {
  sessionId: string
  cols: number
  rows: number
  cwd: string
  env?: Record<string, string>
  shell?: string
  initialCommand?: string
}

export class Session {
  readonly sessionId: string
  private subprocess: ChildProcess | null = null
  private emulator: HeadlessEmulator
  private historyWriter: HistoryWriter
  private promptHistoryWriter: PromptHistoryWriter
  private ptyPid: number | null = null
  private exitCode: number | null = null
  private terminatingAt: Date | null = null
  private disposed = false
  private initialCommand: string | undefined
  private initialCommandSent = false

  // Attached stream sockets
  private streamClients = new Set<net.Socket>()

  // Callbacks
  private onExitCallback: ((sessionId: string, exitCode: number, signal: number) => void) | null = null

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId
    this.emulator = new HeadlessEmulator(opts.cols, opts.rows, opts.cwd)
    this.historyWriter = new HistoryWriter(opts.sessionId, opts.cwd, opts.cols, opts.rows)
    this.promptHistoryWriter = new PromptHistoryWriter(opts.sessionId)
    this.initialCommand = opts.initialCommand
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

  get pid(): number | null {
    return this.ptyPid
  }

  get clientCount(): number {
    return this.streamClients.size
  }

  onExit(cb: (sessionId: string, exitCode: number, signal: number) => void): void {
    this.onExitCallback = cb
  }

  spawn(opts: { cwd: string; cols: number; rows: number; env?: Record<string, string> }): void {
    if (this.subprocess) throw new Error('PTY already spawned')

    // Open history writer for real-time persistence
    this.historyWriter.open()
    this.promptHistoryWriter.open()

    // Determine path to compiled pty-subprocess
    const subprocessPath = join(__dirname, 'pty-subprocess.js')

    this.subprocess = spawn(process.execPath, [subprocessPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
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
          // Subprocess is ready, send spawn command
          const shell = getUserShell()
          const isLoginShell = process.platform === 'darwin'
          const msg: SpawnMessage = {
            shell,
            args: isLoginShell ? ['-l'] : [],
            cwd: opts.cwd,
            cols: opts.cols,
            rows: opts.rows,
            env: { ...process.env as Record<string, string>, ...(opts.env || {}), SHELL: shell }
          }
          writeFrame(this.subprocess!.stdin!, PtyMessageType.Spawn, Buffer.from(JSON.stringify(msg)))
          break
        }

        case PtyMessageType.Spawned: {
          this.ptyPid = payload.readUInt32LE(0)
          break
        }

        case PtyMessageType.Data: {
          const data = payload.toString('utf8')
          // Feed to headless emulator
          this.emulator.write(data)
          // Write to disk in real-time (survives hard kills / reboots)
          this.historyWriter.write(data)
          // Send to all attached stream clients
          for (const client of this.streamClients) {
            sendJson(client, {
              type: 'event',
              event: 'data',
              sessionId: this.sessionId,
              data
            })
          }
          // Send initial command after first data (system-injected, not user prompt)
          if (this.initialCommand && !this.initialCommandSent) {
            this.initialCommandSent = true
            this.write(this.initialCommand + '\n', 'system')
          }
          break
        }

        case PtyMessageType.Exit: {
          const exitCode = payload.readInt32LE(0)
          const signal = payload.readInt32LE(4)
          this.exitCode = exitCode
          this.subprocess = null
          this.ptyPid = null
          // Close history with exit code (marks as cleanly ended)
          this.historyWriter.close(exitCode)
          this.promptHistoryWriter.close()
          // Notify attached clients
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
        this.onExitCallback?.(this.sessionId, -1, 0)
      }
    })
  }

  write(data: string, source: 'user' | 'system' = 'user'): void {
    if (!this.subprocess?.stdin) return
    writeFrame(this.subprocess.stdin, PtyMessageType.Write, Buffer.from(data, 'utf8'))
    if (source === 'user') {
      const submittedText = this.promptHistoryWriter.feedUserInput(data)
      if (submittedText) {
        // Emit prompt event to all attached stream clients
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
    if (!this.subprocess?.stdin) return
    const buf = Buffer.alloc(8)
    buf.writeUInt32LE(cols, 0)
    buf.writeUInt32LE(rows, 4)
    writeFrame(this.subprocess.stdin, PtyMessageType.Resize, buf)
    this.emulator.resize(cols, rows)
    this.historyWriter.updateDimensions(cols, rows)
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
    this.emulator.dispose()
    this.historyWriter.close()
    this.promptHistoryWriter.close()
    this.streamClients.clear()
  }

  /** Remove history files (call on clean session exit) */
  cleanupHistory(): void {
    this.historyWriter.cleanup()
  }
}
