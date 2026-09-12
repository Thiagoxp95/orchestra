import { TerminalApplier, type TerminalSink } from './client.ts'

export class TerminalConnection {
  readonly applier: TerminalApplier
  epoch: string | null = null
  connected = false
  controller = false
  delayMs = 0
  lease = 0
  message = 'Connecting'
  private socket: WebSocket | null = null
  private terminal: TerminalSink
  private endpoint: string
  private changed: () => void
  private disposed = false
  private inputId = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private ackTimer: ReturnType<typeof setTimeout> | undefined

  constructor(terminal: TerminalSink, endpoint: string, changed: () => void) {
    this.terminal = terminal; this.endpoint = endpoint; this.changed = changed
    this.applier = new TerminalApplier(terminal)
    void this.connect()
  }
  private send(message: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)) }
  private async connect() {
    await this.applier.idle()
    if (this.disposed) return
    const ws = new WebSocket(this.endpoint)
    ws.binaryType = 'arraybuffer'
    this.socket = ws
    this.inputId = 0
    ws.onopen = () => this.send({ type: 'attach', epoch: this.epoch, ...this.applier.cursor })
    ws.onmessage = event => {
      if (this.socket !== ws || this.disposed) return
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data)
        if (message.type === 'ready') {
          if (this.epoch === null) this.terminal.resize(message.initial.cols, message.initial.rows)
          this.epoch = message.epoch; this.connected = true; this.message = 'Live'
        } else if (message.type === 'lease') {
          this.controller = message.controller; this.lease = message.lease
        } else if (message.type === 'error' || message.type === 'denied') {
          this.message = message.message
        }
        this.changed()
        return
      }
      void this.applier.accept(new Uint8Array(event.data)).then(() => {
        if (this.socket !== ws || this.disposed) return
        if (!this.ackTimer) this.ackTimer = setTimeout(() => {
          this.ackTimer = undefined
          if (this.socket === ws) this.send({ type: 'ack', ...this.applier.cursor })
        }, Math.max(4, this.delayMs))
        this.changed()
      }).catch(error => { this.message = String(error); ws.close(1008, 'Invalid stream'); this.changed() })
    }
    ws.onclose = event => {
      if (this.socket !== ws || this.disposed) return
      this.connected = false; this.controller = false
      clearTimeout(this.ackTimer); this.ackTimer = undefined
      if (event.code !== 1008) {
        this.message = 'Reconnecting from applied offset'
        this.reconnectTimer = setTimeout(() => void this.connect(), 300)
      }
      this.changed()
    }
    ws.onerror = () => { this.message = 'Connection interrupted'; this.changed() }
  }
  claim() { this.send({ type: 'claim' }) }
  input(data: string) {
    if (!this.controller || !this.connected) { this.message = 'Take control to send input'; this.changed(); return }
    this.send({ type: 'input', lease: this.lease, id: ++this.inputId, data })
  }
  resize(cols: number, rows: number) {
    if (!this.controller || !this.connected) return
    this.send({ type: 'resize', lease: this.lease, id: ++this.inputId, cols, rows })
  }
  reconnect() { this.socket?.close(4000, 'Exercise retained-offset resume') }
  dispose() {
    this.disposed = true
    clearTimeout(this.reconnectTimer); clearTimeout(this.ackTimer)
    this.socket?.close()
  }
}
