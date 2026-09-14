import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { decodeFrame, geometryPayload, type StreamCheckpoint, type StreamRead } from '../shared/terminal-stream/protocol'

export const TERMINAL_RELAY_URL = 'ws://127.0.0.1:13000'
const WINDOW = 64 * 1024
const MAX_HOST_QUEUE = 8 * 1024 * 1024
const MAX_SEED = 4 * 1024 * 1024
interface Cursor { seq: string; offset: string }
interface Geometry { cols: number; rows: number }
export interface StreamDaemon {
  supportsTerminalStream(): boolean
  getTerminalStreamCheckpoint(sessionId: string): Promise<StreamCheckpoint>
  readTerminalStream(sessionId: string, epoch: string, afterSeq: string, maxBytes: number, afterOffset?: string): Promise<StreamRead>
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): Promise<unknown>
}
interface Viewer {
  id: number; sessionId: string; epoch: string | null; cursor: Cursor; acked: Cursor
  pending: Array<{ cursor: Cursor; bytes: number }>; bytes: number
  seed: Cursor | null; attaching: boolean; pumping: boolean; active: boolean
  inputId: number; commands: Promise<void>; queued: number
}
interface Lease { controller: number | null; version: number; token?: string; geometry?: Geometry; release?: ReturnType<typeof setTimeout> }
export interface HostOptions {
  daemon: StreamDaemon
  secret: string
  endpoint?: string
  onGeometry: (sessionId: string, geometry: Geometry | null, epoch: number) => void
}
function cursor(value: Record<string, unknown>): Cursor {
  if (typeof value.seq !== 'string' || typeof value.offset !== 'string' ||
      !/^\d{1,20}$/.test(value.seq) || !/^\d{1,20}$/.test(value.offset) ||
      BigInt(value.seq) > 0xffffffffffffffffn || BigInt(value.offset) > 0xffffffffffffffffn) throw new Error('Invalid cursor')
  return { seq: BigInt(value.seq).toString(), offset: BigInt(value.offset).toString() }
}
const same = (a: Cursor, b: Cursor) => a.seq === b.seq && a.offset === b.offset

/** Owns remote delivery and leases; the daemon owns authoritative event order. */
export class TerminalStreamHost {
  private socket: WebSocket | null = null
  private viewers = new Map<number, Viewer>()
  private leases = new Map<string, Lease>()
  private disposed = false
  private ready = false
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private handshakeTimer?: ReturnType<typeof setTimeout>
  private pingTimer?: ReturnType<typeof setInterval>
  private pongTimer?: ReturnType<typeof setTimeout>
  private poll: ReturnType<typeof setInterval>
  private retry = 500
  constructor(private options: HostOptions) {
    this.connect()
    this.poll = setInterval(() => {
      for (const v of this.viewers.values()) void this.pump(v)
    }, 16)
    this.poll.unref()
  }
  geometry(sessionId: string): Geometry | undefined { return this.leases.get(sessionId)?.geometry }
  captureInputGuard(sessionId: string, token?: unknown): () => void {
    const original = this.leases.get(sessionId)
    const version = original?.version ?? 0
    const check = () => {
      const current = this.leases.get(sessionId)
      if ((current?.version ?? 0) !== version ||
          (token !== undefined ? typeof token !== 'string' || !current?.controller || token !== current.token : !!current?.controller)) {
        throw new Error('Terminal control changed; pending input was cancelled')
      }
    }
    check()
    return check
  }
  reclaim(sessionId: string) {
    const lease = this.leases.get(sessionId)
    if (!lease) return
    clearTimeout(lease.release)
    lease.controller = null; lease.token = undefined; lease.geometry = undefined; lease.version++
    this.options.onGeometry(sessionId, null, lease.version)
    this.broadcastLease(sessionId)
  }
  private connect() {
    if (this.disposed || this.socket) return
    const endpoint = (this.options.endpoint ?? TERMINAL_RELAY_URL).replace(/\/$/, '').replace(/\/host$/, '')
    const ws = new WebSocket(`${endpoint}/host`, { maxPayload: 32 * 1024, perMessageDeflate: false, handshakeTimeout: 5000 })
    this.socket = ws
    // Covers both the HTTP upgrade and the relay's authentication response.
    this.handshakeTimer = setTimeout(() => this.disconnect(ws), 5000)
    ws.on('open', () => { if (this.socket === ws) this.send({ type: 'host', secret: this.options.secret }) })
    ws.on('pong', () => { if (this.socket === ws) { clearTimeout(this.pongTimer); this.pongTimer = undefined } })
    ws.on('error', () => {})
    ws.on('message', (raw, binary) => {
      if (this.socket !== ws || binary) return
      try {
        const m = JSON.parse(raw.toString())
        if (m.type === 'host-ready') {
          clearTimeout(this.handshakeTimer); this.retry = 500; this.ready = true
          clearInterval(this.pingTimer)
          this.pingTimer = setInterval(() => {
            if (this.socket !== ws || this.pongTimer) return
            this.pongTimer = setTimeout(() => this.disconnect(ws), 3000)
            ws.ping()
          }, 5000)
          return
        }
        if (!Number.isInteger(m.id) || m.id < 1 || m.id > 0xffffffff) throw new Error('Invalid viewer')
        if (m.type === 'open' && typeof m.sessionId === 'string') {
          if (this.viewers.size >= 32) return
          const v: Viewer = { id: m.id, sessionId: m.sessionId, epoch: null, cursor: { seq: '0', offset: '0' }, acked: { seq: '0', offset: '0' }, pending: [], bytes: 0, seed: null, attaching: false, pumping: false, active: true, inputId: 0, commands: Promise.resolve(), queued: 0 }
          this.viewers.set(v.id, v)
          if (!this.options.daemon.supportsTerminalStream()) this.control(v, { type: 'unavailable', reason: 'unsupported', message: 'This running daemon uses the earlier terminal transport' })
        } else if (m.type === 'close') this.remove(m.id)
        else if (m.type === 'client') {
          const v = this.viewers.get(m.id)
          if (v) this.command(v, m.message)
        }
      } catch { ws.close(1008, 'Invalid relay envelope') }
    })
    ws.on('close', () => this.disconnect(ws))
  }
  private disconnect(ws: WebSocket) {
    if (this.socket !== ws) return
    const wasReady = this.ready
    this.ready = false
    this.socket = null
    clearTimeout(this.handshakeTimer); clearInterval(this.pingTimer); clearTimeout(this.pongTimer)
    this.pongTimer = undefined
    // Do not wait for a close handshake across a network that may be gone.
    ws.terminate()
    for (const id of [...this.viewers.keys()]) this.remove(id)
    if (!this.disposed) {
      this.reconnectTimer = setTimeout(() => this.connect(), wasReady ? 0 : this.retry + Math.random() * 250)
      if (!wasReady) this.retry = Math.min(10000, this.retry * 2)
    }
  }
  /** Sleep can strand an apparently open socket. Wake always starts fresh. */
  resume() {
    if (this.disposed) return
    if (this.socket) this.disconnect(this.socket)
    clearTimeout(this.reconnectTimer); this.retry = 500
    this.connect()
  }
  private send(value: unknown) {
    const ws = this.socket
    if (ws?.readyState !== WebSocket.OPEN) return false
    const data = JSON.stringify(value)
    if (ws.bufferedAmount + Buffer.byteLength(data) > MAX_HOST_QUEUE) { ws.close(1013, 'Host queue full'); return false }
    ws.send(data); return true
  }
  private control(v: Viewer, message: unknown) { if (v.active) this.send({ type: 'server', id: v.id, message }) }
  private fail(v: Viewer, message: string) {
    this.control(v, { type: 'error', message })
    this.remove(v.id)
  }
  private remove(id: number) {
    const v = this.viewers.get(id)
    if (!v) return
    v.active = false; this.viewers.delete(id)
    const lease = this.leases.get(v.sessionId)
    if (lease?.controller === id) {
      lease.controller = null; lease.token = undefined; lease.version++
      clearTimeout(lease.release)
      lease.release = setTimeout(() => this.reclaim(v.sessionId), 10000)
      this.broadcastLease(v.sessionId)
    }
  }
  private command(v: Viewer, value: unknown) {
    if (!value || typeof value !== 'object') { this.fail(v, 'Invalid command'); return }
    const m = value as Record<string, unknown>
    // ACKs bypass the input chain so a slow RPC never stalls delivery credit.
    if (m.type === 'ack') {
      try { this.ack(v, cursor(m)) } catch { this.fail(v, 'Invalid acknowledgement') }
      return
    }
    if (++v.queued > 64) { this.fail(v, 'Too many pending commands'); return }
    v.commands = v.commands.then(async () => {
      if (!v.active) return
      if (m.type === 'attach') {
        if (!this.options.daemon.supportsTerminalStream()) return
        if (v.epoch || v.attaching) throw new Error('Already attached')
        const position = cursor(m)
        v.attaching = true
        if (typeof m.epoch === 'string') {
          const read = await this.options.daemon.readTerminalStream(v.sessionId, m.epoch, position.seq, WINDOW, position.offset)
          if (!v.active) return
          if (!read.gap && read.epoch === m.epoch) {
            v.epoch = m.epoch; v.cursor = position; v.acked = position; v.attaching = false
            this.control(v, { type: 'ready', epoch: v.epoch }); this.broadcastLease(v.sessionId)
            void this.pump(v); return
          }
        }
        const seed = await this.options.daemon.getTerminalStreamCheckpoint(v.sessionId)
        if (!v.active) return
        if (Buffer.byteLength(JSON.stringify(seed)) > MAX_SEED) throw new Error('Terminal checkpoint exceeds recovery limit')
        v.epoch = seed.epoch; v.cursor = { seq: seed.seq, offset: seed.offset }; v.seed = v.cursor
        v.attaching = false
        this.control(v, { type: 'seed', ...seed, historyExpired: m.epoch !== null })
      } else if (m.type === 'claim') {
        if (!v.epoch || v.seed) return
        const lease: Lease = this.leases.get(v.sessionId) ?? { controller: null, version: 0 }
        clearTimeout(lease.release)
        if (lease.controller === v.id) return
        lease.controller = v.id; lease.token = randomUUID(); lease.version++
        this.leases.set(v.sessionId, lease)
        this.broadcastLease(v.sessionId)
      } else if (m.type === 'resize' || m.type === 'input') {
        const lease = this.leases.get(v.sessionId)
        if (typeof m.id !== 'number' || !Number.isSafeInteger(m.id) || m.id < 1) throw new Error('Invalid input id')
        if (m.id <= v.inputId) return
        if (m.id !== v.inputId + 1) throw new Error('Input sequence gap')
        v.inputId = m.id
        if (!lease || lease.controller !== v.id || m.lease !== lease.version) { this.control(v, { type: 'denied', message: 'Terminal control changed' }); return }
        if (m.type === 'input') {
          if (typeof m.data !== 'string' || Buffer.byteLength(m.data) > 4096) throw new Error('Input exceeds limit')
          this.options.daemon.write(v.sessionId, m.data)
        } else {
          if (typeof m.cols !== 'number' || typeof m.rows !== 'number') throw new Error('Invalid geometry')
          geometryPayload(m.cols, m.rows)
          const geometry = { cols: m.cols, rows: m.rows }
          if (lease.geometry?.cols !== m.cols || lease.geometry?.rows !== m.rows) {
            // Guard desktop IPC before awaiting the daemon so it cannot race fit.
            lease.geometry = geometry
            this.options.onGeometry(v.sessionId, geometry, lease.version)
            await this.options.daemon.resize(v.sessionId, m.cols, m.rows)
          }
        }
        this.control(v, { type: 'accepted', id: m.id })
      } else throw new Error('Unknown command')
    }).catch(() => this.fail(v, 'Terminal stream command failed')).finally(() => { v.queued-- })
  }
  private ack(v: Viewer, position: Cursor) {
    if (v.seed) {
      if (!same(v.seed, position)) throw new Error('Seed cursor mismatch')
      v.seed = null
      v.acked = position
      this.control(v, { type: 'ready', epoch: v.epoch }); this.broadcastLease(v.sessionId)
    } else {
      // Cumulative credits are idempotent, including delayed acknowledgements.
      if (BigInt(position.seq) <= BigInt(v.acked.seq) && BigInt(position.offset) <= BigInt(v.acked.offset)) return
      const index = v.pending.findIndex(p => same(p.cursor, position))
      if (index < 0) {
        if (same(v.cursor, position) && v.pending.length === 0) return
        throw new Error('Unsent cursor')
      }
      for (const p of v.pending.splice(0, index + 1)) v.bytes -= p.bytes
      v.acked = position
    }
    void this.pump(v)
  }
  private broadcastLease(sessionId: string) {
    const lease = this.leases.get(sessionId)
    for (const v of this.viewers.values()) if (v.sessionId === sessionId) this.control(v, { type: 'lease', controller: lease?.controller === v.id, lease: lease?.version ?? 0, ...(lease?.controller === v.id ? { token: lease.token } : {}) })
  }
  private async pump(v: Viewer) {
    if (!v.active || !v.epoch || v.seed || v.attaching || v.pumping || v.bytes >= WINDOW - 18 - 16384) return
    if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > WINDOW) return
    v.pumping = true
    try {
      const read = await this.options.daemon.readTerminalStream(v.sessionId, v.epoch, v.cursor.seq, WINDOW - v.bytes, v.cursor.offset)
      if (!v.active) return
      if (read.gap || read.epoch !== v.epoch) { this.fail(v, 'Retained terminal history expired; reconnect to recover'); return }
      for (const encoded of read.frames) {
        const bytes = Buffer.from(encoded, 'base64')
        if (bytes.length + v.bytes > WINDOW) break
        const frame = decodeFrame(bytes)
        if (frame.seq !== BigInt(v.cursor.seq) + 1n || frame.offset !== BigInt(v.cursor.offset) + BigInt(frame.kind === 'output' ? frame.payload.length : 0)) throw new Error('Daemon stream gap')
        const routed = Buffer.allocUnsafe(4 + bytes.length); routed.writeUInt32BE(v.id); bytes.copy(routed, 4)
        if (this.socket?.readyState !== WebSocket.OPEN) break
        this.socket.send(routed)
        v.cursor = { seq: String(frame.seq), offset: String(frame.offset) }
        v.pending.push({ cursor: v.cursor, bytes: bytes.length }); v.bytes += bytes.length
      }
    } catch { this.fail(v, 'Terminal stream interrupted; reconnect to resume') }
    finally { v.pumping = false }
  }
  dispose() {
    this.disposed = true; clearInterval(this.poll); clearTimeout(this.reconnectTimer)
    clearTimeout(this.handshakeTimer); clearInterval(this.pingTimer); clearTimeout(this.pongTimer)
    for (const lease of this.leases.values()) { clearTimeout(lease.release); lease.controller = null; lease.token = undefined; lease.version++ }
    this.socket?.terminate(); this.socket = null
    for (const v of this.viewers.values()) v.active = false
    this.viewers.clear()
  }
}
