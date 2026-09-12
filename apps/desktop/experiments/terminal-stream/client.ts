import { decodeFrame, readGeometry, type Cursor } from './protocol.ts'

export interface TerminalSink {
  write(bytes: Uint8Array, callback: () => void): void
  resize(cols: number, rows: number): void
}

export class TerminalApplier {
  private terminal: TerminalSink
  private seq = 0n
  private offset = 0n
  private chain: Promise<unknown> = Promise.resolve()
  private pending = 0
  constructor(terminal: TerminalSink) { this.terminal = terminal }
  get cursor(): Cursor { return { seq: String(this.seq), offset: String(this.offset) } }
  get pendingBytes() { return this.pending }
  async idle() { await this.chain }
  accept(bytes: Uint8Array): Promise<Cursor> {
    if (this.pending + bytes.length > 128 * 1024) return Promise.reject(new Error('Client byte window exceeded'))
    this.pending += bytes.length
    const task = this.chain.then(async () => {
      const frame = decodeFrame(bytes)
      if (frame.seq <= this.seq) return this.cursor
      if (frame.seq !== this.seq + 1n) throw new Error('Output sequence gap')
      const expectedOffset = this.offset + (frame.kind === 'output' ? BigInt(frame.payload.length) : 0n)
      if (frame.offset !== expectedOffset) throw new Error('Output byte offset gap')
      if (frame.kind === 'resize') {
        const geometry = readGeometry(frame.payload)
        this.terminal.resize(geometry.cols, geometry.rows)
      } else {
        await new Promise<void>(resolve => this.terminal.write(frame.payload, resolve))
      }
      this.seq = frame.seq; this.offset = frame.offset
      return this.cursor
    }).finally(() => { this.pending -= bytes.length })
    this.chain = task.catch(() => {})
    return task
  }
}
