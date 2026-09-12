import { randomUUID } from 'node:crypto'
import { encodeFrame, geometryPayload, HEADER_BYTES, MAX_PAYLOAD, type Cursor, type StreamRead } from '../shared/terminal-stream/protocol'

export const STREAM_RETENTION_BYTES = 8 * 1024 * 1024
export const STREAM_READ_BYTES = 64 * 1024
export const STREAM_CHECKPOINT_BYTES = 4 * 1024 * 1024
// Also cap object overhead when output arrives as many tiny events.
const MAX_RETAINED_FRAMES = 32_768

/** One incarnation of a PTY's visible output. Storage is allocated on first output. */
export class TerminalStream {
  readonly epoch = randomUUID()
  private frames: Map<bigint, Buffer> | undefined
  private seq = 0n
  private offset = 0n
  private retainedBytes = 0
  private floor = 0n
  private floorOffset = 0n
  private failure: Error | undefined

  constructor(private readonly capacity = STREAM_RETENTION_BYTES) {
    if (capacity < HEADER_BYTES + MAX_PAYLOAD) throw new Error('Stream capacity is too small')
  }

  get head(): Cursor { return { seq: String(this.seq), offset: String(this.offset) } }
  get bytes(): number { return this.retainedBytes }

  append(data: string): void {
    const bytes = Buffer.from(data, 'utf8')
    for (let start = 0; start < bytes.length; start += MAX_PAYLOAD) {
      this.push('output', bytes.subarray(start, start + MAX_PAYLOAD))
    }
  }

  resize(cols: number, rows: number): void {
    try { this.push('resize', geometryPayload(cols, rows)) }
    catch { this.failure = new Error('Unsupported terminal stream geometry') }
  }

  assertSupported(): void { if (this.failure) throw this.failure }

  private push(kind: 'output' | 'resize', payload: Uint8Array): void {
    if (this.seq === 0xffffffffffffffffn || this.offset + BigInt(payload.length) > 0xffffffffffffffffn) {
      throw new Error('Terminal stream cursor exhausted')
    }
    this.seq++
    if (kind === 'output') this.offset += BigInt(payload.length)
    const frame = Buffer.from(encodeFrame({ kind, seq: this.seq, offset: this.offset, payload }))
    this.frames ??= new Map()
    this.frames.set(this.seq, frame)
    this.retainedBytes += frame.length
    while (this.retainedBytes > this.capacity || this.frames.size > MAX_RETAINED_FRAMES) {
      const first = this.frames.keys().next().value!
      const discarded = this.frames.get(first)!
      this.floorOffset = discarded.readBigUInt64BE(10)
      this.retainedBytes -= discarded.length
      this.frames.delete(first)
      this.floor = first
    }
  }

  read(epoch: string, afterSeq: string, maxBytes: number, afterOffset?: string): StreamRead {
    if (this.failure || epoch !== this.epoch || !/^(0|[1-9]\d{0,19})$/.test(afterSeq)) {
      return { epoch: this.epoch, frames: [], gap: true }
    }
    const after = BigInt(afterSeq)
    if (after < this.floor || after > this.seq) return { epoch: this.epoch, frames: [], gap: true }
    if (afterOffset !== undefined) {
      const expected = after === this.floor ? this.floorOffset : this.frames!.get(after)!.readBigUInt64BE(10)
      if (!/^(0|[1-9]\d{0,19})$/.test(afterOffset) || BigInt(afterOffset) !== expected) {
        return { epoch: this.epoch, frames: [], gap: true }
      }
    }
    const limit = Math.min(STREAM_READ_BYTES, Math.max(0, Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 0))
    const frames: string[] = []
    let bytes = 0
    for (let seq = after + 1n; seq <= this.seq; seq++) {
      const frame = this.frames!.get(seq)!
      if (bytes + frame.length > limit) break
      bytes += frame.length
      frames.push(frame.toString('base64'))
    }
    return { epoch: this.epoch, frames, gap: false }
  }
}
