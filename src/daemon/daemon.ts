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
import { Session } from './session'

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
      try {
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
      } catch (err: any) {
        console.error(`[daemon] createOrAttach error:`, err)
        if (msg.id != null) {
          sendJson(socket, { id: msg.id, ok: false, error: err.message })
        }
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
