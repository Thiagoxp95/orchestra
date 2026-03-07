// src/daemon/session.ts
import { spawn, ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import * as net from 'node:net'
import { HeadlessEmulator } from './headless-emulator'
import {
  PtyMessageType, writeFrame, createFrameParser,
  SpawnMessage, SessionSnapshot, sendJson
} from './protocol'

const KILL_TIMEOUT_MS = 5000

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

    // Determine path to compiled pty-subprocess
    const subprocessPath = join(__dirname, 'pty-subprocess.js')

    this.subprocess = spawn(process.execPath, [subprocessPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })

    const parseFrame = createFrameParser((type, payload) => {
      switch (type) {
        case PtyMessageType.Ready: {
          // Subprocess is ready, send spawn command
          const shell = process.env.SHELL || '/bin/zsh'
          const msg: SpawnMessage = {
            shell,
            args: [],
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
          // Send to all attached stream clients
          for (const client of this.streamClients) {
            sendJson(client, {
              type: 'event',
              event: 'data',
              sessionId: this.sessionId,
              data
            })
          }
          // Send initial command after first data
          if (this.initialCommand && !this.initialCommandSent) {
            this.initialCommandSent = true
            this.write(this.initialCommand + '\n')
          }
          break
        }

        case PtyMessageType.Exit: {
          const exitCode = payload.readInt32LE(0)
          const signal = payload.readInt32LE(4)
          this.exitCode = exitCode
          this.subprocess = null
          this.ptyPid = null
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

  write(data: string): void {
    if (!this.subprocess?.stdin) return
    writeFrame(this.subprocess.stdin, PtyMessageType.Write, Buffer.from(data, 'utf8'))
  }

  resize(cols: number, rows: number): void {
    if (!this.subprocess?.stdin) return
    const buf = Buffer.alloc(8)
    buf.writeUInt32LE(cols, 0)
    buf.writeUInt32LE(rows, 4)
    writeFrame(this.subprocess.stdin, PtyMessageType.Resize, buf)
    this.emulator.resize(cols, rows)
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
    this.streamClients.clear()
  }
}
