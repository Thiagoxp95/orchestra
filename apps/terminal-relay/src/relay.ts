import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'

const MAX_VIEWERS = 32
const MAX_BUFFER = 8 * 1024 * 1024
const MAX_CONTROL = 16 * 1024
export interface RelayOptions {
  secret: string
  origins: string[]
  authorize: (token: string, sessionId: string) => Promise<void>
}

/** Single-machine router. No PTYs, terminal parsing, output storage, or logging. */
export function createRelay(options: RelayOptions) {
  if (options.secret.length < 16) throw new Error('Relay secret is missing or too short')
  let host: WebSocket | undefined
  let nextId = 0
  const viewers = new Map<number, { socket: WebSocket; token: string; sessionId: string }>()
  const server = createServer((req, res) => {
    if (req.url !== '/health') { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, protocol: 1, hostConnected: host?.readyState === WebSocket.OPEN, viewers: viewers.size }))
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BUFFER, perMessageDeflate: false })
  const alive = new WeakSet<WebSocket>()
  function send(ws: WebSocket | undefined, data: string | Buffer, binary = false): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    if (ws.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFER) {
      ws.close(1013, 'Delivery window exceeded'); return false
    }
    ws.send(data, { binary }); return true
  }
  const json = (ws: WebSocket | undefined, value: unknown) => send(ws, JSON.stringify(value))
  function unavailable(ws: WebSocket, reason: string) {
    json(ws, { type: 'unavailable', reason, message: 'Desktop terminal connection unavailable' })
    ws.close(1013, reason)
  }
  server.on('upgrade', (req, socket, head) => {
    const path = req.url
    if ((path !== '/host' && path !== '/viewer') || wss.clients.size >= MAX_VIEWERS + 8 ||
      (path === '/viewer' && !options.origins.includes(req.headers.origin ?? ''))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    wss.handleUpgrade(req, socket, head, ws => {
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
        if (Date.now() - rateAt >= 1000) { messages = 0; claims = 0; rateAt = Date.now() }
        if (++messages > 500 && path === '/viewer') { ws.close(1008, 'Rate limit'); return }
        if (!authenticated) {
          if (authenticating || binary || bytes.length > MAX_CONTROL) { ws.close(1008, 'Invalid authentication'); return }
          authenticating = true
          void (async () => {
            const m = JSON.parse(bytes.toString())
            if (path === '/host') {
              const expected = Buffer.from(options.secret)
              const provided = Buffer.from(typeof m.secret === 'string' ? m.secret : '')
              if (m.type !== 'host' || expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw new Error('Unauthorized')
              if (host?.readyState === WebSocket.OPEN) { ws.close(1013, 'Host already connected'); return }
              if (ws.readyState !== WebSocket.OPEN) return
              host = ws
              json(ws, { type: 'host-ready', protocol: 1 })
            } else {
              if (m.type !== 'viewer' || typeof m.token !== 'string' || m.token.length > 512 || typeof m.sessionId !== 'string' || m.sessionId.length > 256) throw new Error('Unauthorized')
              await options.authorize(m.token, m.sessionId)
              if (ws.readyState !== WebSocket.OPEN) return
              if (!host || host.readyState !== WebSocket.OPEN) { unavailable(ws, 'offline'); return }
              if (viewers.size >= MAX_VIEWERS || nextId >= 0xffffffff) { ws.close(1013, 'Viewer limit'); return }
              id = ++nextId
              viewers.set(id, { socket: ws, token: m.token, sessionId: m.sessionId })
              json(host, { type: 'open', id, sessionId: m.sessionId })
              json(ws, { type: 'authenticated' })
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
              if (m.type !== 'server' || !Number.isInteger(m.id) || typeof m.message !== 'object' || m.message === null) throw new Error('Invalid envelope')
              json(viewers.get(m.id)?.socket, m.message)
            }
          } else {
            if (binary || bytes.length > MAX_CONTROL) throw new Error('Invalid control')
            const message: unknown = JSON.parse(bytes.toString())
            if (!message || typeof message !== 'object') throw new Error('Invalid control')
            if ('type' in message && message.type === 'claim' && ++claims > 10) { ws.close(1008, 'Control claim rate limit'); return }
            json(host, { type: 'client', id, message })
          }
        } catch { ws.close(1008, 'Invalid message') }
      })
      ws.on('close', () => {
        clearTimeout(authTimer)
        if (host === ws) {
          host = undefined
          for (const v of viewers.values()) unavailable(v.socket, 'offline')
        }
        if (id !== undefined) { viewers.delete(id); json(host, { type: 'close', id }) }
      })
    })
  })
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) { ws.terminate(); continue }
      alive.delete(ws); ws.ping()
    }
  }, 15000)
  let rechecking = false
  const authorization = setInterval(() => {
    if (rechecking) return
    rechecking = true
    void Promise.allSettled([...viewers.values()].map(async v => {
      try { await options.authorize(v.token, v.sessionId) }
      catch { v.socket.close(1008, 'Authorization expired') }
    })).finally(() => { rechecking = false })
  }, 60000)
  return {
    server,
    async close() {
      clearInterval(heartbeat); clearInterval(authorization)
      for (const ws of wss.clients) ws.terminate()
      wss.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
