import { geometryPayload } from '../../../../desktop/src/shared/terminal-stream/protocol'
import { TerminalApplier, type Seed } from './applier'
export interface StreamSocket {
  readyState: number; bufferedAmount: number; binaryType: string
  onopen: ((event: Event) => void) | null; onclose: ((event: CloseEvent) => void) | null; onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  send(data: string): void
  close(): void
}
export interface ConnectionOptions {
  token: string; sessionId: string; applier: TerminalApplier; url?: string
  socketFactory?: (url: string) => StreamSocket
  onStatus?: (status: string) => void
  onController?: (controller: boolean) => void
  onUnsupported?: () => void
  onHistoryExpired?: () => void
  onApplied?: () => void
}
/** Owns exactly one transport. Input is never queued for a future connection. */
export class TerminalConnection {
  private socket: StreamSocket | null = null
  private stopped = false
  private active = true
  private ready = false
  private controller = false
  private lease = 0
  private leaseToken?: string
  private id = 0
  private retry = 500
  private draining = false
  private immediate = false
  private retryTimer?: ReturnType<typeof setTimeout>
  private handshakeTimer?: ReturnType<typeof setTimeout>
  private pingTimer?: ReturnType<typeof setInterval>
  private pongTimer?: ReturnType<typeof setTimeout>
  private resizeTimer?: ReturnType<typeof setTimeout>
  private geometry?: { cols: number; rows: number }
  private settledGeometry?: { cols: number; rows: number }
  constructor(private options: ConnectionOptions) {}
  get inputLease() { return this.isController ? this.leaseToken : undefined }
  get isController() { return this.ready && this.controller && this.active }
  start() { if (!this.socket && !this.stopped && !this.draining && !this.retryTimer) this.connect() }
  private send(message: unknown): boolean {
    const ws = this.socket
    if (!ws || ws.readyState !== 1) return false
    const data = JSON.stringify(message)
    if (ws.bufferedAmount + new TextEncoder().encode(data).byteLength > 128 * 1024) { this.reconnect('Connection is catching up…'); return false }
    ws.send(data); return true
  }
  private connect() {
    if (this.stopped || this.socket) return
    this.retryTimer = undefined
    const base = this.options.url ?? process.env.NEXT_PUBLIC_TERMINAL_RELAY_URL ?? 'wss://orchestra-terminal-relay.fly.dev'
    const url = base.replace(/\/$/, '').replace(/\/viewer$/, '') + '/viewer'
    const ws: StreamSocket = this.options.socketFactory ? this.options.socketFactory(url) : new WebSocket(url)
    this.socket = ws; this.id = 0; this.ready = false; this.setController(false)
    ws.binaryType = 'arraybuffer'
    this.options.onStatus?.('Connecting…')
    this.handshakeTimer = setTimeout(() => this.reconnect('Connection interrupted. Reconnecting…'), 15000)
    ws.onopen = () => { if (ws === this.socket) this.send({ type: 'viewer', token: this.options.token, sessionId: this.options.sessionId, waitForHost: true }) }
    ws.onmessage = event => {
      if (ws !== this.socket) return
      try {
        if (event.data instanceof ArrayBuffer) {
          if (!this.ready) throw new Error('Output before ready')
          void this.options.applier.frame(new Uint8Array(event.data)).then(cursor => {
            if (ws !== this.socket) return
            this.send({ type: 'ack', ...cursor }); this.options.onApplied?.()
          }).catch(() => { if (ws === this.socket) this.reconnect('Terminal stream interrupted. Reconnecting…') })
          return
        }
        if (typeof event.data !== 'string' || event.data.length > 4 * 1024 * 1024 + 4096) throw new Error('Invalid message')
        const m = JSON.parse(event.data)
        if ((m.type === 'waiting' || m.type === 'authenticated') && m.heartbeat === true) this.startHeartbeat()
        if (m.type === 'pong') {
          clearTimeout(this.pongTimer); this.pongTimer = undefined
        } else if (m.type === 'waiting') {
          clearTimeout(this.handshakeTimer)
          this.options.onStatus?.('Waiting for desktop connection…')
        } else if (m.type === 'unavailable') {
          if (m.reason === 'unsupported') { this.dispose(); this.options.onUnsupported?.() }
          else this.reconnect('Desktop unavailable. Reconnecting…')
        } else if (m.type === 'authenticated') {
          clearTimeout(this.handshakeTimer)
          this.handshakeTimer = setTimeout(() => this.reconnect('Terminal attach interrupted. Reconnecting…'), 15000)
          this.send({ type: 'attach', epoch: this.options.applier.epoch, ...this.options.applier.applied })
        } else if (m.type === 'seed') {
          this.ready = false
          void this.options.applier.seed(m as Seed).then(cursor => {
            if (ws !== this.socket) return
            if (m.historyExpired) this.options.onHistoryExpired?.()
            this.send({ type: 'ack', ...cursor }); this.options.onApplied?.()
          }).catch(() => { if (ws === this.socket) this.reconnect('Checkpoint interrupted. Reconnecting…') })
        } else if (m.type === 'ready') {
          if (m.epoch !== this.options.applier.epoch) throw new Error('Epoch mismatch')
          clearTimeout(this.handshakeTimer); this.retry = 500; this.ready = true
          this.options.onStatus?.(''); if (this.active) this.claim()
        } else if (m.type === 'lease') {
          if (!Number.isSafeInteger(m.lease) || m.lease < 0 || typeof m.controller !== 'boolean') throw new Error('Invalid lease')
          this.leaseToken = m.controller && typeof m.token === 'string' ? m.token : undefined
          this.lease = m.lease; this.setController(m.controller)
          if (this.isController && this.settledGeometry && !this.resizeTimer) this.sendResize()
        } else if (m.type === 'denied') { this.setController(false); this.options.onStatus?.('Terminal control changed. Activate this view to take control.') }
        else if (m.type === 'error') this.reconnect('Terminal stream interrupted. Reconnecting…')
      } catch { this.reconnect('Terminal stream interrupted. Reconnecting…') }
    }
    ws.onerror = () => { if (ws === this.socket) this.reconnect('Connection interrupted. Reconnecting…') }
    ws.onclose = () => { if (ws === this.socket) this.reconnect('Connection interrupted. Reconnecting…') }
  }
  private setController(value: boolean) { this.controller = value; this.options.onController?.(this.isController) }
  private startHeartbeat() {
    if (this.pingTimer) return
    this.pingTimer = setInterval(() => {
      if (this.pongTimer) return
      this.pongTimer = setTimeout(() => this.reconnect('Connection interrupted. Reconnecting…'), 5000)
      this.send({ type: 'ping' })
    }, 10000)
  }
  private reconnect(message: string, immediate = false) {
    if (this.stopped) return
    this.immediate ||= immediate
    clearTimeout(this.retryTimer); this.retryTimer = undefined
    this.options.onStatus?.(message); this.ready = false; this.setController(false)
    clearTimeout(this.handshakeTimer)
    clearInterval(this.pingTimer); this.pingTimer = undefined
    clearTimeout(this.pongTimer); this.pongTimer = undefined
    const ws = this.socket; this.socket = null; ws?.close()
    if (this.draining) return
    this.draining = true
    void this.options.applier.drain().then(() => {
      this.draining = false
      if (this.stopped) return
      if (this.immediate) { this.immediate = false; this.connect(); return }
      this.retryTimer = setTimeout(() => this.connect(), this.retry)
      this.retry = Math.min(10000, this.retry * 2)
    })
  }
  resume() {
    this.retry = 500
    this.reconnect('Connecting…', true)
  }
  setActive(active: boolean) {
    const changed = active !== this.active; this.active = active
    this.options.onController?.(this.isController)
    if (active && changed) this.resume()
  }
  claim() { if (this.active && this.ready) this.send({ type: 'claim' }) }
  resize(cols: number, rows: number) {
    geometryPayload(cols, rows)
    this.geometry = { cols, rows }; clearTimeout(this.resizeTimer)
    this.resizeTimer = setTimeout(() => { this.resizeTimer = undefined; this.settledGeometry = this.geometry; this.sendResize() }, 120)
  }
  private sendResize() {
    if (this.isController && this.settledGeometry) this.send({ type: 'resize', lease: this.lease, id: ++this.id, ...this.settledGeometry })
  }
  input(data: string): boolean {
    if (!data || !this.isController) return false
    let part = ''; let bytes = 0
    for (const char of data) {
      const size = new TextEncoder().encode(char).length
      if (bytes + size > 4096) { if (!this.send({ type: 'input', lease: this.lease, id: ++this.id, data: part })) return false; part = ''; bytes = 0 }
      part += char; bytes += size
    }
    return this.send({ type: 'input', lease: this.lease, id: ++this.id, data: part })
  }
  dispose() {
    this.stopped = true; this.ready = false; this.setController(false)
    clearTimeout(this.retryTimer); clearTimeout(this.handshakeTimer); clearTimeout(this.resizeTimer)
    clearInterval(this.pingTimer); clearTimeout(this.pongTimer)
    const ws = this.socket; this.socket = null; ws?.close()
  }
}
