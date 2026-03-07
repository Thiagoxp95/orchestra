# Persistent Terminal Daemon — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace direct node-pty spawning with a persistent daemon so terminal sessions survive app restarts.

**Architecture:** Detached Node.js daemon process communicates with Electron over Unix sockets (NDJSON protocol). Daemon owns PTY subprocesses (binary framing) and headless xterm emulators (SerializeAddon) for perfect snapshot/restore.

**Tech Stack:** Node.js, node-pty, @xterm/headless, @xterm/addon-serialize, tree-kill, Unix domain sockets, NDJSON

---

## Context for Implementer

The Orchestra app is an Electron terminal orchestrator. Current architecture spawns PTYs directly in the main process — sessions die on app quit. We're replacing this with a Superset-style persistent daemon.

**Current files that matter:**
- `src/main/pty-manager.ts` — will be REPLACED by daemon-client
- `src/main/index.ts` — IPC handlers, will be MODIFIED to use daemon-client
- `src/main/process-monitor.ts` — imports from pty-manager, will be MODIFIED
- `src/main/persistence.ts` — stays, still persists workspace/session metadata
- `src/shared/types.ts` — will ADD daemon protocol types
- `src/preload/index.ts` — NO CHANGES (IPC bridge stays same)
- `src/renderer/` — NO CHANGES (renderer talks to main via IPC, main bridges to daemon)

**Key packages to install:**
- `@xterm/headless` (headless xterm for daemon)
- `@xterm/addon-serialize` (SerializeAddon for snapshots)
- `tree-kill` (kill process trees)

**Daemon files location:** `src/daemon/` — these run as a separate Node.js process, NOT inside Electron.

**Electron-vite build:** The daemon files need their own build entry or to be compiled separately since they run outside Electron. We'll add a daemon build config.

---

### Task 1: Install Dependencies and Add Protocol Types

**Files:**
- Modify: `package.json`
- Modify: `src/shared/types.ts`
- Create: `src/daemon/protocol.ts`

**Step 1: Install new packages**

```bash
npm install @xterm/headless @xterm/addon-serialize tree-kill
npm install -D @types/tree-kill
```

**Step 2: Add daemon protocol types to `src/daemon/protocol.ts`**

```typescript
// src/daemon/protocol.ts
// Binary framing for PTY subprocess communication

export enum PtyMessageType {
  // Parent -> subprocess
  Spawn = 1,
  Write = 2,
  Resize = 3,
  Kill = 4,
  Dispose = 5,
  Signal = 6,
  // Subprocess -> parent
  Ready = 101,
  Spawned = 102,
  Data = 103,
  Exit = 104,
  Error = 105
}

export interface SpawnMessage {
  shell: string
  args: string[]
  cwd: string
  cols: number
  rows: number
  env: Record<string, string>
}

// NDJSON protocol for Electron <-> Daemon communication

export interface DaemonRequest {
  id?: number | string  // omit for fire-and-forget
  type: 'hello' | 'createOrAttach' | 'write' | 'resize' | 'kill' | 'signal' | 'listSessions' | 'detach'
  [key: string]: any
}

export interface DaemonResponse {
  id: number | string
  ok: boolean
  error?: string
  [key: string]: any
}

export interface DaemonEvent {
  type: 'event'
  event: 'data' | 'exit'
  sessionId: string
  [key: string]: any
}

export interface SessionSnapshot {
  snapshotAnsi: string
  rehydrateSequences: string
  cwd: string
  cols: number
  rows: number
}

export interface SessionInfo {
  sessionId: string
  pid: number | null
  cwd: string
  isAlive: boolean
}

// Binary frame helpers

export function writeFrame(stream: NodeJS.WritableStream, type: PtyMessageType, payload: Buffer): boolean {
  const header = Buffer.alloc(5)
  header.writeUInt8(type, 0)
  header.writeUInt32LE(payload.length, 1)
  stream.write(header)
  return stream.write(payload)
}

export function createFrameParser(onFrame: (type: PtyMessageType, payload: Buffer) => void) {
  let buffer = Buffer.alloc(0)

  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])

    while (buffer.length >= 5) {
      const type = buffer.readUInt8(0) as PtyMessageType
      const payloadLen = buffer.readUInt32LE(1)

      if (buffer.length < 5 + payloadLen) break // incomplete frame

      const payload = buffer.subarray(5, 5 + payloadLen)
      buffer = buffer.subarray(5 + payloadLen)
      onFrame(type, payload)
    }
  }
}

// NDJSON helpers

export function sendJson(socket: NodeJS.WritableStream, obj: any): void {
  socket.write(JSON.stringify(obj) + '\n')
}

export function createJsonParser(onMessage: (msg: any) => void) {
  let buffer = ''

  return (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.trim()) {
        try {
          onMessage(JSON.parse(line))
        } catch {}
      }
    }
  }
}

export const DAEMON_DIR = process.env.HOME + '/.orchestra'
export const DAEMON_SOCKET_PATH = DAEMON_DIR + '/daemon.sock'
export const DAEMON_PID_PATH = DAEMON_DIR + '/daemon.pid'
export const HISTORY_DIR = DAEMON_DIR + '/terminal-history'
```

**Step 3: Commit**

```bash
git add package.json package-lock.json src/daemon/protocol.ts src/shared/types.ts
git commit -m "feat: add daemon protocol types and install headless xterm dependencies"
```

---

### Task 2: PTY Subprocess

The PTY subprocess is a standalone Node.js script spawned by the daemon (one per terminal). It uses node-pty to create the actual shell and communicates with the daemon via binary framing over stdin/stdout.

**Files:**
- Create: `src/daemon/pty-subprocess.ts`

**Step 1: Implement pty-subprocess.ts**

```typescript
// src/daemon/pty-subprocess.ts
// Standalone Node.js process that wraps a single node-pty instance.
// Communicates with parent daemon via binary framing on stdin/stdout.

import * as pty from 'node-pty'
import { PtyMessageType, writeFrame, createFrameParser, SpawnMessage } from './protocol'

let ptyProcess: pty.IPty | null = null
let ptyPaused = false

// Output batching: coalesce output chunks, flush every 32ms or 128KB
const outputChunks: Buffer[] = []
let outputSize = 0
const BATCH_INTERVAL_MS = 32
const BATCH_MAX_BYTES = 128 * 1024

let batchTimer: ReturnType<typeof setInterval> | null = null

function flushOutput(): void {
  if (outputChunks.length === 0) return
  const payload = Buffer.concat(outputChunks)
  outputChunks.length = 0
  outputSize = 0

  const ok = writeFrame(process.stdout, PtyMessageType.Data, payload)
  if (!ok && ptyProcess && !ptyPaused) {
    ptyPaused = true
    ptyProcess.pause()
  }
}

process.stdout.on('drain', () => {
  if (ptyPaused && ptyProcess) {
    ptyPaused = false
    ptyProcess.resume()
  }
})

function sendError(message: string): void {
  writeFrame(process.stdout, PtyMessageType.Error, Buffer.from(message, 'utf8'))
}

// Handle incoming frames from parent
const parseFrame = createFrameParser((type, payload) => {
  switch (type) {
    case PtyMessageType.Spawn: {
      if (ptyProcess) {
        sendError('PTY already spawned')
        return
      }
      const msg: SpawnMessage = JSON.parse(payload.toString('utf8'))
      try {
        ptyProcess = pty.spawn(msg.shell, msg.args, {
          name: 'xterm-256color',
          cols: msg.cols,
          rows: msg.rows,
          cwd: msg.cwd,
          env: msg.env
        })

        ptyProcess.onData((data) => {
          const buf = Buffer.from(data, 'utf8')
          outputChunks.push(buf)
          outputSize += buf.length
          if (outputSize >= BATCH_MAX_BYTES) flushOutput()
        })

        ptyProcess.onExit(({ exitCode, signal }) => {
          const exitPayload = Buffer.alloc(8)
          exitPayload.writeInt32LE(exitCode ?? -1, 0)
          exitPayload.writeInt32LE(signal ?? 0, 4)
          flushOutput()
          writeFrame(process.stdout, PtyMessageType.Exit, exitPayload)
          ptyProcess = null
        })

        // Send spawned with PID
        const pidPayload = Buffer.alloc(4)
        pidPayload.writeUInt32LE(ptyProcess.pid ?? 0, 0)
        writeFrame(process.stdout, PtyMessageType.Spawned, pidPayload)

        // Start output batching timer
        batchTimer = setInterval(flushOutput, BATCH_INTERVAL_MS)
      } catch (err: any) {
        sendError(`Spawn failed: ${err.message}`)
      }
      break
    }

    case PtyMessageType.Write: {
      if (!ptyProcess) return
      ptyProcess.write(payload.toString('utf8'))
      break
    }

    case PtyMessageType.Resize: {
      if (!ptyProcess) return
      const cols = payload.readUInt32LE(0)
      const rows = payload.readUInt32LE(4)
      try {
        ptyProcess.resize(cols, rows)
      } catch {}
      break
    }

    case PtyMessageType.Kill: {
      if (!ptyProcess) return
      const signal = payload.length > 0 ? payload.toString('utf8') : 'SIGTERM'
      ptyProcess.kill(signal)
      break
    }

    case PtyMessageType.Signal: {
      if (!ptyProcess) return
      const sig = payload.toString('utf8')
      ptyProcess.kill(sig)
      break
    }

    case PtyMessageType.Dispose: {
      if (ptyProcess) {
        ptyProcess.kill('SIGKILL')
        ptyProcess = null
      }
      if (batchTimer) clearInterval(batchTimer)
      process.exit(0)
      break
    }
  }
})

// Read binary frames from stdin
process.stdin.on('data', (chunk: Buffer) => {
  parseFrame(chunk)
})

process.stdin.on('end', () => {
  if (ptyProcess) ptyProcess.kill('SIGKILL')
  if (batchTimer) clearInterval(batchTimer)
  process.exit(0)
})

// Tell parent we're ready
writeFrame(process.stdout, PtyMessageType.Ready, Buffer.alloc(0))
```

**Step 2: Commit**

```bash
git add src/daemon/pty-subprocess.ts
git commit -m "feat: add PTY subprocess with binary framing"
```

---

### Task 3: Headless Emulator

Wraps `@xterm/headless` + `@xterm/addon-serialize` to track terminal state server-side. Parses DECSET/DECRST for mode tracking and OSC-7 for CWD.

**Files:**
- Create: `src/daemon/headless-emulator.ts`

**Step 1: Implement headless-emulator.ts**

```typescript
// src/daemon/headless-emulator.ts
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { SessionSnapshot } from './protocol'

export interface TerminalModes {
  applicationCursorKeys: boolean
  originMode: boolean
  autoWrap: boolean
  cursorVisible: boolean
  bracketedPaste: boolean
  mouseTracking: boolean
  mouseSgr: boolean
  focusReporting: boolean
  alternateScreen: boolean
}

const DEFAULT_MODES: TerminalModes = {
  applicationCursorKeys: false,
  originMode: false,
  autoWrap: true,
  cursorVisible: true,
  bracketedPaste: false,
  mouseTracking: false,
  mouseSgr: false,
  focusReporting: false,
  alternateScreen: false
}

const MODE_MAP: Record<number, keyof TerminalModes> = {
  1: 'applicationCursorKeys',
  6: 'originMode',
  7: 'autoWrap',
  25: 'cursorVisible',
  1000: 'mouseTracking',
  1002: 'mouseTracking',
  1003: 'mouseTracking',
  1006: 'mouseSgr',
  1004: 'focusReporting',
  2004: 'bracketedPaste',
  47: 'alternateScreen',
  1049: 'alternateScreen'
}

export class HeadlessEmulator {
  private terminal: Terminal
  private serializeAddon: SerializeAddon
  private modes: TerminalModes = { ...DEFAULT_MODES }
  private cwd: string = ''
  private disposed = false

  // Write queue for async batched processing
  private writeQueue: string[] = []
  private writeScheduled = false
  private hasClients = false

  constructor(cols: number, rows: number, cwd: string) {
    this.terminal = new Terminal({ cols, rows, scrollback: 2000 })
    this.serializeAddon = new SerializeAddon()
    this.terminal.loadAddon(this.serializeAddon)
    this.cwd = cwd
  }

  setHasClients(has: boolean): void {
    this.hasClients = has
  }

  write(data: string): void {
    this.writeQueue.push(data)
    this.parseEscapeSequences(data)
    if (!this.writeScheduled) {
      this.writeScheduled = true
      setImmediate(() => this.processWriteQueue())
    }
  }

  private processWriteQueue(): void {
    this.writeScheduled = false
    if (this.disposed) return

    const timeBudget = this.hasClients ? 5 : 25
    const start = performance.now()

    while (this.writeQueue.length > 0) {
      const chunk = this.writeQueue.shift()!
      this.terminal.write(chunk)
      if (performance.now() - start > timeBudget) {
        // Reschedule remaining
        if (this.writeQueue.length > 0 && !this.writeScheduled) {
          this.writeScheduled = true
          setImmediate(() => this.processWriteQueue())
        }
        return
      }
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return
    this.terminal.resize(cols, rows)
  }

  getSnapshot(): SessionSnapshot {
    const snapshotAnsi = this.serializeAddon.serialize({
      scrollback: this.terminal.options.scrollback ?? 2000
    })
    const rehydrateSequences = this.generateRehydrateSequences()
    return {
      snapshotAnsi,
      rehydrateSequences,
      cwd: this.cwd,
      cols: this.terminal.cols,
      rows: this.terminal.rows
    }
  }

  async getSnapshotAsync(): Promise<SessionSnapshot> {
    // Flush pending writes
    await new Promise<void>((resolve) => {
      this.terminal.write('', () => resolve())
    })
    return this.getSnapshot()
  }

  getCwd(): string {
    return this.cwd
  }

  getDimensions(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.terminal.dispose()
  }

  // Parse DECSET/DECRST mode changes and OSC-7 CWD
  private parseEscapeSequences(data: string): void {
    // DECSET: ESC[?Nh  DECRST: ESC[?Nl
    const modeRegex = /\x1b\[\?(\d+)([hl])/g
    let match: RegExpExecArray | null
    while ((match = modeRegex.exec(data)) !== null) {
      const mode = parseInt(match[1], 10)
      const set = match[2] === 'h'
      const key = MODE_MAP[mode]
      if (key) {
        this.modes[key] = set
      }
    }

    // OSC-7: ESC]7;file://hostname/path BEL or ST
    const osc7Regex = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*?)(?:\x07|\x1b\\)/g
    while ((match = osc7Regex.exec(data)) !== null) {
      const path = decodeURIComponent(match[1])
      if (path) this.cwd = path
    }
  }

  private generateRehydrateSequences(): string {
    let seq = ''
    // Only emit non-default modes
    for (const [code, key] of Object.entries(MODE_MAP)) {
      if (this.modes[key] !== DEFAULT_MODES[key]) {
        seq += `\x1b[?${code}${this.modes[key] ? 'h' : 'l'}`
      }
    }
    return seq
  }
}
```

**Step 2: Commit**

```bash
git add src/daemon/headless-emulator.ts
git commit -m "feat: add headless xterm emulator with serialize and mode tracking"
```

---

### Task 4: Session Class

Manages one terminal session: owns a PTY subprocess and a HeadlessEmulator.

**Files:**
- Create: `src/daemon/session.ts`

**Step 1: Implement session.ts**

```typescript
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
```

**Step 2: Commit**

```bash
git add src/daemon/session.ts
git commit -m "feat: add Session class with PTY subprocess and headless emulator"
```

---

### Task 5: Terminal Daemon (Socket Server + TerminalHost)

The main daemon entry point. Runs as a detached process, listens on Unix socket, manages all sessions.

**Files:**
- Create: `src/daemon/daemon.ts`

**Step 1: Implement daemon.ts**

```typescript
// src/daemon/daemon.ts
// Persistent terminal daemon — runs outside Electron as a detached Node.js process.
// Listens on Unix domain socket, manages terminal sessions.

import * as net from 'node:net'
import * as fs from 'node:fs'
import { mkdirSync } from 'node:fs'
import {
  DAEMON_DIR, DAEMON_SOCKET_PATH, DAEMON_PID_PATH,
  sendJson, createJsonParser,
  DaemonRequest, SessionSnapshot
} from './protocol'
import { Session, SessionOptions } from './session'

// TerminalHost: manages all sessions
class TerminalHost {
  private sessions = new Map<string, Session>()
  private killTimers = new Map<string, ReturnType<typeof setTimeout>>()

  createOrAttach(
    request: {
      sessionId: string
      cwd: string
      cols: number
      rows: number
      env?: Record<string, string>
      initialCommand?: string
    },
    streamSocket: net.Socket | null
  ): { isNew: boolean; snapshot: SessionSnapshot | null; pid: number | null } {
    let session = this.sessions.get(request.sessionId)
    let isNew = false

    // Clean up terminated sessions
    if (session?.isTerminating) {
      session.dispose()
      this.sessions.delete(request.sessionId)
      session = undefined
    }
    if (session && !session.isAlive) {
      session.dispose()
      this.sessions.delete(request.sessionId)
      session = undefined
    }

    if (!session) {
      session = new Session({
        sessionId: request.sessionId,
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd,
        initialCommand: request.initialCommand
      })

      session.onExit((id) => {
        // Session exited — keep in map for potential snapshot access
        // Clean up after delay
        setTimeout(() => {
          const s = this.sessions.get(id)
          if (s && !s.isAlive) {
            s.dispose()
            this.sessions.delete(id)
          }
        }, 5000)
      })

      session.spawn({
        cwd: request.cwd,
        cols: request.cols,
        rows: request.rows,
        env: request.env
      })

      this.sessions.set(request.sessionId, session)
      isNew = true
    } else {
      // Existing session — resize to new client dimensions
      try { session.resize(request.cols, request.rows) } catch {}
    }

    // Attach stream socket if provided
    let snapshot: SessionSnapshot | null = null
    if (streamSocket) {
      // We need to do this synchronously for the response
      // Use the sync snapshot since attach is in an async context handled by caller
    }

    return { isNew, snapshot, pid: session.pid }
  }

  async attachStream(sessionId: string, socket: net.Socket): Promise<SessionSnapshot | null> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAttachable) return null
    return session.attach(socket)
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.isAttachable) session.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (session?.isAttachable) session.resize(cols, rows)
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.kill()

    // Fail-safe cleanup
    if (!this.killTimers.has(sessionId)) {
      const timer = setTimeout(() => {
        const s = this.sessions.get(sessionId)
        if (s?.isTerminating) {
          s.dispose()
          this.sessions.delete(sessionId)
        }
        this.killTimers.delete(sessionId)
      }, 5000)
      this.killTimers.set(sessionId, timer)
    }
  }

  signal(sessionId: string, sig: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.isAttachable) session.sendSignal(sig)
  }

  detach(sessionId: string, socket: net.Socket): void {
    const session = this.sessions.get(sessionId)
    if (session) session.detach(socket)
  }

  listSessions(): { sessionId: string; pid: number | null; cwd: string; isAlive: boolean }[] {
    return Array.from(this.sessions.values()).map((s) => s.getMeta())
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose()
    }
    this.sessions.clear()
    for (const timer of this.killTimers.values()) clearTimeout(timer)
    this.killTimers.clear()
  }
}

// Socket server
const host = new TerminalHost()

// Track client state: which socket is control vs stream
interface ClientState {
  role: 'control' | 'stream' | null
  streamSocket: net.Socket | null
  controlSocket: net.Socket | null
  clientId: string | null
}

const clientStates = new Map<net.Socket, ClientState>()
// Map clientId -> stream socket for pairing
const streamByClientId = new Map<string, net.Socket>()
const controlByClientId = new Map<string, net.Socket>()

function getStreamForClient(clientId: string): net.Socket | null {
  return streamByClientId.get(clientId) || null
}

async function handleMessage(socket: net.Socket, msg: DaemonRequest): Promise<void> {
  const state = clientStates.get(socket)!

  if (msg.type === 'hello') {
    state.role = msg.role
    state.clientId = msg.clientId
    if (msg.role === 'stream') {
      streamByClientId.set(msg.clientId, socket)
    } else if (msg.role === 'control') {
      controlByClientId.set(msg.clientId, socket)
    }
    if (msg.id != null) {
      sendJson(socket, { id: msg.id, ok: true })
    }
    return
  }

  // All other messages require control role
  if (state.role !== 'control') return

  switch (msg.type) {
    case 'createOrAttach': {
      const result = host.createOrAttach({
        sessionId: msg.sessionId,
        cwd: msg.cwd,
        cols: msg.cols,
        rows: msg.rows,
        env: msg.env,
        initialCommand: msg.initialCommand
      }, null)

      // Attach stream socket
      const stream = state.clientId ? getStreamForClient(state.clientId) : null
      let snapshot: SessionSnapshot | null = null
      if (stream) {
        snapshot = await host.attachStream(msg.sessionId, stream)
      }

      if (msg.id != null) {
        sendJson(socket, {
          id: msg.id,
          ok: true,
          isNew: result.isNew,
          pid: result.pid,
          snapshot
        })
      }
      break
    }

    case 'write': {
      host.write(msg.sessionId, msg.data)
      // Fire-and-forget, no response unless id present
      if (msg.id != null && typeof msg.id === 'number') {
        sendJson(socket, { id: msg.id, ok: true })
      }
      break
    }

    case 'resize': {
      host.resize(msg.sessionId, msg.cols, msg.rows)
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true })
      break
    }

    case 'kill': {
      host.kill(msg.sessionId)
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true })
      break
    }

    case 'signal': {
      host.signal(msg.sessionId, msg.signal)
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true })
      break
    }

    case 'detach': {
      const stream = state.clientId ? getStreamForClient(state.clientId) : null
      if (stream) host.detach(msg.sessionId, stream)
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true })
      break
    }

    case 'listSessions': {
      const sessions = host.listSessions()
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true, sessions })
      break
    }
  }
}

// Create server
mkdirSync(DAEMON_DIR, { recursive: true })

// Remove stale socket
try { fs.unlinkSync(DAEMON_SOCKET_PATH) } catch {}

const server = net.createServer((socket) => {
  clientStates.set(socket, { role: null, clientId: null, streamSocket: null, controlSocket: null })

  const parse = createJsonParser((msg) => handleMessage(socket, msg))
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => parse(chunk))

  socket.on('close', () => {
    const state = clientStates.get(socket)
    if (state?.clientId) {
      if (state.role === 'stream') {
        streamByClientId.delete(state.clientId)
        // Detach this socket from all sessions
        for (const session of host.listSessions()) {
          host.detach(session.sessionId, socket)
        }
      }
      if (state.role === 'control') {
        controlByClientId.delete(state.clientId)
      }
    }
    clientStates.delete(socket)
  })

  socket.on('error', () => {
    socket.destroy()
  })
})

server.listen(DAEMON_SOCKET_PATH, () => {
  // Write PID file
  fs.writeFileSync(DAEMON_PID_PATH, String(process.pid))
  console.log(`[daemon] Listening on ${DAEMON_SOCKET_PATH} (PID ${process.pid})`)
})

// Handle shutdown signals
function shutdown(): void {
  host.disposeAll()
  server.close()
  try { fs.unlinkSync(DAEMON_SOCKET_PATH) } catch {}
  try { fs.unlinkSync(DAEMON_PID_PATH) } catch {}
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
```

**Step 2: Commit**

```bash
git add src/daemon/daemon.ts
git commit -m "feat: add terminal daemon with Unix socket server and session management"
```

---

### Task 6: Daemon Launcher

Electron-side module that spawns the daemon if not running, or connects to existing one.

**Files:**
- Create: `src/main/daemon-launcher.ts`

**Step 1: Implement daemon-launcher.ts**

```typescript
// src/main/daemon-launcher.ts
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import { join } from 'node:path'
import { DAEMON_DIR, DAEMON_SOCKET_PATH, DAEMON_PID_PATH } from '../daemon/protocol'

function isDaemonRunning(): boolean {
  try {
    const pid = parseInt(fs.readFileSync(DAEMON_PID_PATH, 'utf8').trim(), 10)
    process.kill(pid, 0) // Check if process exists (signal 0)
    return true
  } catch {
    return false
  }
}

function canConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(DAEMON_SOCKET_PATH)
    socket.on('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => {
      resolve(false)
    })
    setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 1000)
  })
}

function spawnDaemon(): void {
  fs.mkdirSync(DAEMON_DIR, { recursive: true })

  // Path to compiled daemon.js — lives alongside main process files
  const daemonPath = join(__dirname, '../daemon/daemon.js')

  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })

  child.unref()
}

export async function ensureDaemon(): Promise<void> {
  // Fast path: daemon already running and connectable
  if (isDaemonRunning() && await canConnect()) return

  // Clean up stale files
  try { fs.unlinkSync(DAEMON_SOCKET_PATH) } catch {}
  try { fs.unlinkSync(DAEMON_PID_PATH) } catch {}

  // Spawn fresh daemon
  spawnDaemon()

  // Wait for socket to become available
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (await canConnect()) return
  }

  throw new Error('Failed to start terminal daemon')
}
```

**Step 2: Commit**

```bash
git add src/main/daemon-launcher.ts
git commit -m "feat: add daemon launcher to spawn/find persistent daemon"
```

---

### Task 7: Daemon Client

Electron-side client that connects to the daemon with dual sockets and exposes API.

**Files:**
- Create: `src/main/daemon-client.ts`

**Step 1: Implement daemon-client.ts**

```typescript
// src/main/daemon-client.ts
import * as net from 'node:net'
import * as crypto from 'node:crypto'
import { BrowserWindow } from 'electron'
import {
  DAEMON_SOCKET_PATH, sendJson, createJsonParser,
  DaemonResponse, DaemonEvent, SessionSnapshot, SessionInfo
} from '../daemon/protocol'
import { ensureDaemon } from './daemon-launcher'

export class DaemonClient {
  private controlSocket: net.Socket | null = null
  private streamSocket: net.Socket | null = null
  private clientId = crypto.randomUUID()
  private requestId = 0
  private pendingRequests = new Map<number | string, {
    resolve: (value: any) => void
    reject: (error: Error) => void
  }>()
  private window: BrowserWindow | null = null
  private connected = false

  async connect(window: BrowserWindow): Promise<void> {
    this.window = window
    await ensureDaemon()

    // Open control socket
    this.controlSocket = await this.openSocket('control')

    // Open stream socket
    this.streamSocket = await this.openSocket('stream')

    // Listen for events on stream socket
    const parseStream = createJsonParser((msg: DaemonEvent) => {
      if (msg.type === 'event' && this.window && !this.window.isDestroyed()) {
        if (msg.event === 'data') {
          this.window.webContents.send('terminal-data', msg.sessionId, msg.data)
        } else if (msg.event === 'exit') {
          this.window.webContents.send('terminal-exit', msg.sessionId)
        }
      }
    })
    this.streamSocket.setEncoding('utf8')
    this.streamSocket.on('data', (chunk: string) => parseStream(chunk))

    // Listen for responses on control socket
    const parseControl = createJsonParser((msg: DaemonResponse) => {
      if (msg.id != null) {
        const pending = this.pendingRequests.get(msg.id)
        if (pending) {
          this.pendingRequests.delete(msg.id)
          if (msg.ok) {
            pending.resolve(msg)
          } else {
            pending.reject(new Error(msg.error || 'Request failed'))
          }
        }
      }
    })
    this.controlSocket.setEncoding('utf8')
    this.controlSocket.on('data', (chunk: string) => parseControl(chunk))

    this.connected = true
  }

  private openSocket(role: 'control' | 'stream'): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(DAEMON_SOCKET_PATH)
      socket.on('connect', () => {
        sendJson(socket, { type: 'hello', role, clientId: this.clientId })
        resolve(socket)
      })
      socket.on('error', (err) => reject(err))
    })
  }

  private request(msg: any): Promise<any> {
    if (!this.controlSocket) throw new Error('Not connected')
    const id = ++this.requestId
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })
      sendJson(this.controlSocket!, { ...msg, id })
      // Timeout
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error('Request timeout'))
        }
      }, 10000)
    })
  }

  async createOrAttach(
    sessionId: string,
    opts: { cwd: string; cols: number; rows: number; initialCommand?: string }
  ): Promise<{ isNew: boolean; snapshot: SessionSnapshot | null; pid: number | null }> {
    const resp = await this.request({
      type: 'createOrAttach',
      sessionId,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      initialCommand: opts.initialCommand
    })
    return { isNew: resp.isNew, snapshot: resp.snapshot, pid: resp.pid }
  }

  write(sessionId: string, data: string): void {
    // Fire-and-forget
    if (this.controlSocket) {
      sendJson(this.controlSocket, { type: 'write', sessionId, data })
    }
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.request({ type: 'resize', sessionId, cols, rows })
  }

  async kill(sessionId: string): Promise<void> {
    await this.request({ type: 'kill', sessionId })
  }

  async listSessions(): Promise<SessionInfo[]> {
    const resp = await this.request({ type: 'listSessions' })
    return resp.sessions
  }

  detach(sessionId: string): void {
    if (this.controlSocket) {
      sendJson(this.controlSocket, { type: 'detach', sessionId })
    }
  }

  disconnect(): void {
    this.controlSocket?.destroy()
    this.streamSocket?.destroy()
    this.controlSocket = null
    this.streamSocket = null
    this.connected = false
    this.pendingRequests.clear()
  }

  isConnected(): boolean {
    return this.connected
  }
}

// Singleton
let client: DaemonClient | null = null

export function getDaemonClient(): DaemonClient {
  if (!client) client = new DaemonClient()
  return client
}
```

**Step 2: Commit**

```bash
git add src/main/daemon-client.ts
git commit -m "feat: add daemon client with dual socket connection"
```

---

### Task 8: History Manager (Cold Restore)

Appends terminal output to disk for fallback recovery when daemon crashes.

**Files:**
- Create: `src/main/history-manager.ts`

**Step 1: Implement history-manager.ts**

```typescript
// src/main/history-manager.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import { HISTORY_DIR } from '../daemon/protocol'

const MAX_HISTORY_BYTES = 5 * 1024 * 1024 // 5MB per session

interface HistoryMeta {
  cwd: string
  cols: number
  rows: number
  startedAt: string
  endedAt?: string
}

// Active writers
const writers = new Map<string, { fd: number; bytesWritten: number; dir: string }>()

function sessionDir(workspaceId: string, sessionId: string): string {
  return path.join(HISTORY_DIR, workspaceId, sessionId)
}

export function startHistoryWriter(workspaceId: string, sessionId: string, meta: Omit<HistoryMeta, 'startedAt'>): void {
  const dir = sessionDir(workspaceId, sessionId)
  fs.mkdirSync(dir, { recursive: true })

  // Write meta
  const metaData: HistoryMeta = { ...meta, startedAt: new Date().toISOString() }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(metaData))

  // Open scrollback file for appending
  const fd = fs.openSync(path.join(dir, 'scrollback.bin'), 'w')
  writers.set(sessionId, { fd, bytesWritten: 0, dir })
}

export function appendHistoryData(sessionId: string, data: string): void {
  const writer = writers.get(sessionId)
  if (!writer) return
  if (writer.bytesWritten >= MAX_HISTORY_BYTES) return

  const buf = Buffer.from(data, 'utf8')
  const toWrite = Math.min(buf.length, MAX_HISTORY_BYTES - writer.bytesWritten)
  fs.writeSync(writer.fd, buf, 0, toWrite)
  writer.bytesWritten += toWrite
}

export function endHistoryWriter(sessionId: string): void {
  const writer = writers.get(sessionId)
  if (!writer) return

  fs.closeSync(writer.fd)

  // Update meta with endedAt
  try {
    const metaPath = path.join(writer.dir, 'meta.json')
    const meta: HistoryMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    meta.endedAt = new Date().toISOString()
    fs.writeFileSync(metaPath, JSON.stringify(meta))
  } catch {}

  writers.delete(sessionId)
}

export function loadColdRestore(workspaceId: string, sessionId: string): { scrollback: string; meta: HistoryMeta } | null {
  const dir = sessionDir(workspaceId, sessionId)

  try {
    const meta: HistoryMeta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
    // Only restore if no endedAt (unclean shutdown)
    if (meta.endedAt) return null

    const scrollback = fs.readFileSync(path.join(dir, 'scrollback.bin'), 'utf8')
    return { scrollback, meta }
  } catch {
    return null
  }
}

export function cleanupHistory(workspaceId: string, sessionId: string): void {
  const dir = sessionDir(workspaceId, sessionId)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
}
```

**Step 2: Commit**

```bash
git add src/main/history-manager.ts
git commit -m "feat: add history manager for cold restore fallback"
```

---

### Task 9: Integrate Daemon into Electron Main Process

Replace pty-manager with daemon-client in the main process. Update IPC handlers and process monitor.

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/process-monitor.ts`
- Delete: `src/main/pty-manager.ts` (no longer needed)

**Step 1: Rewrite `src/main/index.ts`**

```typescript
// src/main/index.ts
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { getDaemonClient } from './daemon-client'
import { startMonitoring, stopMonitoring } from './process-monitor'
import { loadPersistedData, saveWorkspaces } from './persistence'

let mainWindow: BrowserWindow | null = null

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Connect to daemon
  const client = getDaemonClient()
  await client.connect(mainWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  startMonitoring(mainWindow, client)

  mainWindow.on('close', () => {
    stopMonitoring()
    // Just disconnect — daemon keeps running
    client.disconnect()
  })
}

// IPC Handlers
ipcMain.on('terminal-create', async (_, sessionId, opts) => {
  const client = getDaemonClient()
  const result = await client.createOrAttach(sessionId, {
    cwd: opts.cwd,
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    initialCommand: opts.initialCommand
  })

  // If reattaching, send snapshot to renderer
  if (result.snapshot && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal-snapshot', sessionId, result.snapshot)
  }
})

ipcMain.on('terminal-write', (_, sessionId, data) => {
  getDaemonClient().write(sessionId, data)
})

ipcMain.on('terminal-resize', (_, sessionId, cols, rows) => {
  getDaemonClient().resize(sessionId, cols, rows).catch(() => {})
})

ipcMain.on('terminal-kill', (_, sessionId) => {
  getDaemonClient().kill(sessionId).catch(() => {})
})

ipcMain.on('save-state', (_, data) => {
  saveWorkspaces(data.workspaces, data.sessions, data.activeWorkspaceId, data.activeSessionId, data.settings)
})

ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('get-persisted-data', () => {
  return loadPersistedData()
})

ipcMain.handle('list-daemon-sessions', async () => {
  return getDaemonClient().listSessions()
})

// App lifecycle
app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  app.quit()
})
```

**Step 2: Update `src/main/process-monitor.ts` to use daemon client**

```typescript
// src/main/process-monitor.ts
import { execFile } from 'node:child_process'
import { BrowserWindow } from 'electron'
import type { ProcessStatus } from '../shared/types'
import type { DaemonClient } from './daemon-client'

const lastStatus = new Map<string, ProcessStatus>()
let interval: ReturnType<typeof setInterval> | null = null
let daemonClient: DaemonClient | null = null

function detectProcess(pid: number): Promise<ProcessStatus> {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid,ppid,args'], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve('terminal')
        return
      }
      const children = new Map<string, string[]>()
      const argsMap = new Map<string, string>()
      const lines = stdout.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        const parts = trimmed.split(/\s+/)
        if (parts.length < 3) continue
        const cpid = parts[0]
        const ppid = parts[1]
        const args = parts.slice(2).join(' ').toLowerCase()
        argsMap.set(cpid, args)
        if (!children.has(ppid)) children.set(ppid, [])
        children.get(ppid)!.push(cpid)
      }

      const queue = [String(pid)]
      while (queue.length > 0) {
        const current = queue.shift()!
        const kids = children.get(current) || []
        for (const kid of kids) {
          const args = argsMap.get(kid) || ''
          if (args.includes('claude')) {
            resolve('claude')
            return
          }
          if (args.includes('codex')) {
            resolve('codex')
            return
          }
          queue.push(kid)
        }
      }
      resolve('terminal')
    })
  })
}

export function startMonitoring(window: BrowserWindow, client: DaemonClient): void {
  if (interval) return
  daemonClient = client

  interval = setInterval(async () => {
    if (window.isDestroyed() || !daemonClient?.isConnected()) return

    try {
      const sessions = await daemonClient.listSessions()
      for (const session of sessions) {
        if (!session.isAlive || !session.pid) continue

        const status = await detectProcess(session.pid)
        const prev = lastStatus.get(session.sessionId)
        if (status !== prev) {
          lastStatus.set(session.sessionId, status)
          window.webContents.send('process-change', session.sessionId, status)
        }
      }
    } catch {}
  }, 2000)
}

export function stopMonitoring(): void {
  if (interval) {
    clearInterval(interval)
    interval = null
  }
  lastStatus.clear()
  daemonClient = null
}
```

**Step 3: Delete `src/main/pty-manager.ts`**

```bash
rm src/main/pty-manager.ts
```

**Step 4: Commit**

```bash
git add src/main/index.ts src/main/process-monitor.ts
git rm src/main/pty-manager.ts
git commit -m "feat: replace pty-manager with daemon client integration"
```

---

### Task 10: Handle Snapshot in Renderer

When reattaching, the main process sends a `terminal-snapshot` event. The renderer needs to write the snapshot ANSI to the xterm instance.

**Files:**
- Modify: `src/preload/index.ts` — add `onTerminalSnapshot` handler
- Modify: `src/shared/types.ts` — add snapshot handler to ElectronAPI
- Modify: `src/renderer/src/hooks/useTerminal.ts` — listen for and apply snapshots

**Step 1: Update preload**

Add to `src/preload/index.ts` the snapshot listener:

```typescript
  onTerminalSnapshot: (callback: (sessionId: string, snapshot: any) => void) => {
    const handler = (_event: any, sessionId: string, snapshot: any) => callback(sessionId, snapshot)
    ipcRenderer.on('terminal-snapshot', handler)
    return () => { ipcRenderer.removeListener('terminal-snapshot', handler) }
  },
```

**Step 2: Update ElectronAPI type in `src/shared/types.ts`**

Add:

```typescript
  onTerminalSnapshot: (callback: (sessionId: string, snapshot: any) => void) => () => void
```

**Step 3: Update `useTerminal.ts` to apply snapshots**

Add snapshot listener inside the `useEffect`, before the return cleanup:

```typescript
    // Listen for snapshot on reattach (daemon restore)
    const removeSnapshotListener = api.onTerminalSnapshot((sid: string, snapshot: any) => {
      if (sid === sessionId && snapshot) {
        term.reset()
        if (snapshot.rehydrateSequences) {
          term.write(snapshot.rehydrateSequences)
        }
        if (snapshot.snapshotAnsi) {
          term.write(snapshot.snapshotAnsi)
        }
      }
    })
```

And in cleanup:

```typescript
    return () => {
      removeSnapshotListener()
      removeDataListener()
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
```

**Step 4: Commit**

```bash
git add src/preload/index.ts src/shared/types.ts src/renderer/src/hooks/useTerminal.ts
git commit -m "feat: handle terminal snapshot restore in renderer"
```

---

### Task 11: Build Configuration for Daemon

The daemon files need to be compiled separately since they run outside Electron.

**Files:**
- Modify: `electron.vite.config.ts`
- Modify: `package.json` (add build script)

**Step 1: Add daemon build to electron.vite.config.ts**

The daemon files (`src/daemon/`) need to be compiled as a separate entry. electron-vite supports multiple entries. Add daemon as another main entry or use a separate build step.

Simplest approach: add daemon files as additional entries in the main config:

```typescript
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['electron-store'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          daemon: resolve('src/daemon/daemon.ts'),
          'pty-subprocess': resolve('src/daemon/pty-subprocess.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [tailwindcss(), react()]
  }
})
```

This compiles daemon.ts and pty-subprocess.ts alongside the main process, outputting to `out/main/daemon.js` and `out/main/pty-subprocess.js`.

**Step 2: Update daemon-launcher.ts path**

The daemon path should point to the compiled output:

```typescript
const daemonPath = join(__dirname, 'daemon.js')  // same directory as index.js in out/main/
```

Similarly in session.ts:

```typescript
const subprocessPath = join(__dirname, 'pty-subprocess.js')
```

Wait — if daemon runs as a detached process with `ELECTRON_RUN_AS_NODE=1`, it needs access to the compiled JS. Since electron-vite outputs to `out/main/`, and the daemon is launched by the Electron main process that lives in the same directory, the `__dirname` references should work.

**Step 3: Commit**

```bash
git add electron.vite.config.ts
git commit -m "feat: add daemon and pty-subprocess to build config"
```

---

### Task 12: End-to-End Testing

Manually test the full flow.

**Step 1: Build and run**

```bash
npm run dev
```

**Step 2: Test new session creation**

1. Create a workspace
2. Click Claude button (or terminal button)
3. Verify terminal appears with shell prompt
4. Type commands, verify output
5. Verify process detection (Claude/Codex icons)

**Step 3: Test session persistence**

1. Open a session, run `cc` (Claude Code) or any long-running process
2. Quit the app (Cmd+Q)
3. Verify daemon still running: `ps aux | grep daemon`
4. Reopen the app
5. Verify terminal restores with exact screen content
6. Verify running process (Claude Code) is still interactive

**Step 4: Test daemon crash recovery**

1. Kill the daemon: `kill $(cat ~/.orchestra/daemon.pid)`
2. Reopen the app
3. Verify it spawns a new daemon
4. Sessions show fresh shells (running processes lost — expected)

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: end-to-end testing fixes for daemon architecture"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Dependencies + protocol types | `package.json`, `src/daemon/protocol.ts` |
| 2 | PTY subprocess (binary framing) | `src/daemon/pty-subprocess.ts` |
| 3 | Headless emulator (xterm + serialize) | `src/daemon/headless-emulator.ts` |
| 4 | Session class | `src/daemon/session.ts` |
| 5 | Daemon (socket server + TerminalHost) | `src/daemon/daemon.ts` |
| 6 | Daemon launcher | `src/main/daemon-launcher.ts` |
| 7 | Daemon client (dual socket) | `src/main/daemon-client.ts` |
| 8 | History manager (cold restore) | `src/main/history-manager.ts` |
| 9 | Integration (replace pty-manager) | `src/main/index.ts`, `process-monitor.ts` |
| 10 | Snapshot handling in renderer | `preload`, `types`, `useTerminal` |
| 11 | Build configuration | `electron.vite.config.ts` |
| 12 | End-to-end testing | Manual testing |
