// src/main/local-server/relay.ts
//
// Terminal byte router between the desktop's TerminalStreamHost and the phone's
// xterm viewers. This ran as its own process (apps/terminal-relay) behind its
// own launch agent; it now lives on the Electron server's HTTP listener.
//
// The routing itself is unchanged — the host still dials in over loopback, so
// the streaming protocol, leases, and backpressure behaviour are untouched.
// What changed is who authorizes a viewer: there are no session tokens any
// more, so a viewer is admitted when the session it names actually exists in
// the state mirror the phone is already reading.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'

const MAX_VIEWERS = 32
const MAX_BUFFER = 8 * 1024 * 1024
const MAX_CONTROL = 16 * 1024

export interface RelayOptions {
  /** Admits a viewer for this session, or throws. */
  authorize: (sessionId: string) => void
  /** Accepts a browser Origin header. */
  allowOrigin: (origin: string | undefined, req: IncomingMessage) => boolean
}

export interface Relay {
  /** Shared with the in-process host so nothing else on the Mac can impersonate it. */
  readonly hostSecret: string
  handleUpgrade: (path: string, req: IncomingMessage, socket: Duplex, head: Buffer) => boolean
  close: () => Promise<void>
}

export function createRelay(options: RelayOptions): Relay {
  const hostSecret = randomBytes(32).toString('hex')
  let host: WebSocket | undefined
  let nextId = 0
  const viewers = new Map<number, { socket: WebSocket; sessionId: string; waiting: boolean }>()
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BUFFER, perMessageDeflate: false })
  const alive = new WeakSet<WebSocket>()

  function send(ws: WebSocket | undefined, data: string | Buffer, binary = false): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    if (ws.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFER) {
      ws.close(1013, 'Delivery window exceeded')
      return false
    }
    ws.send(data, { binary })
    return true
  }

  const json = (ws: WebSocket | undefined, value: unknown) => send(ws, JSON.stringify(value))

  function unavailable(ws: WebSocket, reason: string) {
    json(ws, { type: 'unavailable', reason, message: 'Desktop terminal connection unavailable' })
    ws.close(1013, reason)
  }

  function handleUpgrade(path: string, req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (path !== '/host' && path !== '/viewer') return false
    if (
      wss.clients.size >= MAX_VIEWERS + 8 ||
      (path === '/viewer' && !options.allowOrigin(req.headers.origin, req))
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return true
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.add(ws)
      ws.on('pong', () => alive.add(ws))
      ws.on('error', () => {})
      let authenticated = false
      let authenticating = false
      let id: number | undefined
      let messages = 0
      let claims = 0
      let rateAt = Date.now()
      const authTimer = setTimeout(() => ws.close(1008, 'Authentication timeout'), 5000)

      ws.on('message', (raw, binary) => {
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
        if (Date.now() - rateAt >= 1000) {
          messages = 0
          claims = 0
          rateAt = Date.now()
        }
        if (++messages > 500 && path === '/viewer') {
          ws.close(1008, 'Rate limit')
          return
        }
        if (!authenticated) {
          if (authenticating || binary || bytes.length > MAX_CONTROL) {
            ws.close(1008, 'Invalid authentication')
            return
          }
          authenticating = true
          void (async () => {
            const m = JSON.parse(bytes.toString())
            if (path === '/host') {
              const expected = Buffer.from(hostSecret)
              const provided = Buffer.from(typeof m.secret === 'string' ? m.secret : '')
              if (
                m.type !== 'host' ||
                expected.length !== provided.length ||
                !timingSafeEqual(expected, provided)
              ) {
                throw new Error('Unauthorized')
              }
              if (host?.readyState === WebSocket.OPEN) {
                ws.close(1013, 'Host already connected')
                return
              }
              if (ws.readyState !== WebSocket.OPEN) return
              host = ws
              json(ws, { type: 'host-ready', protocol: 1 })
              for (const [viewerId, viewer] of viewers) {
                if (!viewer.waiting || viewer.socket.readyState !== WebSocket.OPEN) continue
                viewer.waiting = false
                json(ws, { type: 'open', id: viewerId, sessionId: viewer.sessionId })
                json(viewer.socket, { type: 'authenticated', heartbeat: true })
              }
            } else {
              if (m.type !== 'viewer' || typeof m.sessionId !== 'string' || m.sessionId.length > 256) {
                throw new Error('Unauthorized')
              }
              options.authorize(m.sessionId)
              if (ws.readyState !== WebSocket.OPEN) return
              const waiting = !host || host.readyState !== WebSocket.OPEN
              if (waiting && m.waitForHost !== true) {
                unavailable(ws, 'offline')
                return
              }
              if (viewers.size >= MAX_VIEWERS || nextId >= 0xffffffff) {
                ws.close(1013, 'Viewer limit')
                return
              }
              id = ++nextId
              viewers.set(id, { socket: ws, sessionId: m.sessionId, waiting })
              if (!waiting) json(host, { type: 'open', id, sessionId: m.sessionId })
              json(ws, { type: waiting ? 'waiting' : 'authenticated', heartbeat: true })
            }
            authenticated = true
            clearTimeout(authTimer)
          })().catch(() => ws.close(1008, 'Unauthorized'))
          return
        }
        try {
          if (path === '/host') {
            if (host !== ws) return
            if (binary) {
              if (bytes.length < 22 || bytes.length > 4 + 18 + 16 * 1024) throw new Error('Invalid frame')
              send(viewers.get(bytes.readUInt32BE(0))?.socket, bytes.subarray(4), true)
            } else {
              const m = JSON.parse(bytes.toString())
              if (m.type !== 'server' || !Number.isInteger(m.id) || typeof m.message !== 'object' || m.message === null) {
                throw new Error('Invalid envelope')
              }
              json(viewers.get(m.id)?.socket, m.message)
            }
          } else {
            if (binary || bytes.length > MAX_CONTROL) throw new Error('Invalid control')
            const message: unknown = JSON.parse(bytes.toString())
            if (!message || typeof message !== 'object') throw new Error('Invalid control')
            if ('type' in message && message.type === 'ping') {
              json(ws, { type: 'pong' })
              return
            }
            if (id === undefined || viewers.get(id)?.waiting) throw new Error('Desktop not connected')
            if ('type' in message && message.type === 'claim' && ++claims > 10) {
              ws.close(1008, 'Control claim rate limit')
              return
            }
            json(host, { type: 'client', id, message })
          }
        } catch {
          ws.close(1008, 'Invalid message')
        }
      })

      ws.on('close', () => {
        clearTimeout(authTimer)
        if (host === ws) {
          host = undefined
          for (const v of viewers.values()) unavailable(v.socket, 'offline')
        }
        if (id !== undefined) {
          viewers.delete(id)
          json(host, { type: 'close', id })
        }
      })
    })
    return true
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate()
        continue
      }
      alive.delete(ws)
      ws.ping()
    }
  }, 15000)

  // A session can end while a phone is still watching it. Re-checking on a slow
  // clock closes those viewers instead of leaving them attached to nothing.
  const authorization = setInterval(() => {
    for (const viewer of viewers.values()) {
      try {
        options.authorize(viewer.sessionId)
      } catch {
        viewer.socket.close(1008, 'Authorization expired')
      }
    }
  }, 60000)

  return {
    hostSecret,
    handleUpgrade,
    async close() {
      clearInterval(heartbeat)
      clearInterval(authorization)
      for (const ws of wss.clients) ws.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
