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
  type: 'hello' | 'createOrAttach' | 'write' | 'resize' | 'kill' | 'signal' | 'listSessions' | 'detach' | 'getPromptHistory'
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
  event: 'data' | 'exit' | 'prompt'
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

const isDev = process.env.NODE_ENV === 'development' || !!process.env.ELECTRON_IS_DEV
export const DAEMON_DIR = process.env.HOME + '/.orchestra' + (isDev ? '-dev' : '')
export const DAEMON_SOCKET_PATH = DAEMON_DIR + '/daemon.sock'
export const DAEMON_PID_PATH = DAEMON_DIR + '/daemon.pid'
export const HISTORY_DIR = DAEMON_DIR + '/terminal-history'
export const PROMPT_HISTORY_DIR = DAEMON_DIR + '/prompt-history'
export const SNAPSHOTS_DIR = DAEMON_DIR + '/snapshots'
