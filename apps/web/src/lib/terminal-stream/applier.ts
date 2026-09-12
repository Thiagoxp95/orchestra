import { decodeFrame, readGeometry, geometryPayload, type Cursor, type StreamCheckpoint } from '../../../../desktop/src/shared/terminal-stream/protocol'

export interface TerminalSink {
  write(data: string | Uint8Array, callback: () => void): void
  resize(cols: number, rows: number): void
  buffer: { active: { baseY: number; viewportY: number; type?: string; cursorY?: number; getLine?(line: number): { translateToString(trimRight?: boolean): string } | undefined } }
  scrollToLine(line: number): void
  registerMarker?(cursorYOffset: number): { line: number; isDisposed: boolean; dispose(): void } | undefined
}
export type Seed = StreamCheckpoint & { historyExpired: boolean }
export interface TerminalSurface {
  onHistoryExpired?(): void
  current(): TerminalSink
  stage(seed: Seed): { terminal: TerminalSink; commit(): void; dispose(): void }
}
const MAX_PENDING = 128 * 1024
interface OutputBatch {
  parts: Uint8Array[]
  payloadBytes: number
  bytes: number
  cursor: Cursor
}

/** Parser completion, rather than network receipt, is the resumable cursor. */
export class TerminalApplier {
  epoch: string | null = null
  applied: Cursor = { seq: '0', offset: '0' }
  pendingBytes = 0
  private received: Cursor = this.applied
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false
  private pendingOutput?: { batch: OutputBatch; done: Promise<Cursor> }
  constructor(private surface: TerminalSurface) {}
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task)
    this.tail = next.catch(() => {})
    return next
  }
  drain(): Promise<unknown> { return this.tail }
  seed(seed: Seed): Promise<Cursor> {
    if (!seed || typeof seed.epoch !== 'string' || !seed.epoch || typeof seed.data !== 'string' ||
        !/^\d{1,20}$/.test(seed.seq) || !/^\d{1,20}$/.test(seed.offset) ||
        BigInt(seed.seq) > 0xffffffffffffffffn || BigInt(seed.offset) > 0xffffffffffffffffn ||
        new TextEncoder().encode(seed.data).byteLength > 4 * 1024 * 1024) throw new Error('Invalid checkpoint')
    geometryPayload(seed.cols, seed.rows)
    this.pendingOutput = undefined
    this.received = { seq: seed.seq, offset: seed.offset }
    return this.enqueue(async () => {
      if (this.disposed) throw new Error('Disposed')
      const old = this.surface.current().buffer.active
      const anchor = old.viewportY < old.baseY ? old.viewportY : null
      const anchorText = anchor === null ? undefined : old.getLine?.(anchor)?.translateToString(true)
      const staged = this.surface.stage(seed)
      try {
        staged.terminal.resize(seed.cols, seed.rows)
        await new Promise<void>((resolve) => staged.terminal.write(seed.data, resolve))
        if (this.disposed) throw new Error('Disposed')
        if (anchor !== null) {
          const buffer = staged.terminal.buffer.active
          let retained = seed.historyExpired ? null : Math.min(anchor, buffer.baseY)
          if (anchorText?.trim() && buffer.getLine) {
            retained = null
            // Checkpoint scrollback is bounded to 10,000 lines. Match retained
            // content rather than distance from a live bottom that has moved.
            for (let line = Math.min(buffer.baseY, 10000); line >= 0; line--) {
              if (buffer.getLine(line)?.translateToString(true) === anchorText) { retained = line; break }
            }
          }
          if (retained !== null) staged.terminal.scrollToLine(retained)
        }
        staged.commit()
        this.epoch = seed.epoch
        this.applied = { seq: seed.seq, offset: seed.offset }
        return this.applied
      } catch (error) { staged.dispose(); throw error }
    })
  }
  frame(bytes: Uint8Array): Promise<Cursor> {
    if (!this.epoch) throw new Error('Frame before checkpoint')
    const frame = decodeFrame(bytes)
    const nextOffset = BigInt(this.received.offset) + BigInt(frame.kind === 'output' ? frame.payload.byteLength : 0)
    if (frame.seq !== BigInt(this.received.seq) + 1n || frame.offset !== nextOffset) throw new Error('Terminal stream gap')
    if (this.pendingBytes + bytes.byteLength > MAX_PENDING) throw new Error('Terminal pending bytes exceeded')
    this.received = { seq: String(frame.seq), offset: String(frame.offset) }
    this.pendingBytes += bytes.byteLength
    const position = this.received
    // Join output that is still waiting for the parser. Serializing every tiny
    // network frame through its own xterm timer turns a burst into seconds of
    // catch-up in browsers. A resize or checkpoint is always a batch boundary.
    if (frame.kind === 'output' && this.pendingOutput) {
      const { batch, done } = this.pendingOutput
      batch.parts.push(frame.payload)
      batch.payloadBytes += frame.payload.byteLength
      batch.bytes += bytes.byteLength
      batch.cursor = position
      return done.then(() => position)
    }
    const batch: OutputBatch = { parts: [frame.payload], payloadBytes: frame.payload.byteLength, bytes: bytes.byteLength, cursor: position }
    this.pendingOutput = undefined
    const done = this.enqueue(async () => {
      if (this.pendingOutput?.batch === batch) this.pendingOutput = undefined
      try {
        if (this.disposed) throw new Error('Disposed')
        const terminal = this.surface.current()
        const buffer = terminal.buffer.active
        const anchor = buffer.type !== 'alternate' && buffer.viewportY < buffer.baseY ? buffer.viewportY : null
        const marker = anchor === null ? undefined : terminal.registerMarker?.(anchor - buffer.baseY - (buffer.cursorY ?? 0))
        try {
          if (frame.kind === 'output') {
            let payload = batch.parts[0]
            if (batch.parts.length > 1) {
              payload = new Uint8Array(batch.payloadBytes)
              let offset = 0
              for (const part of batch.parts) { payload.set(part, offset); offset += part.byteLength }
            }
            await new Promise<void>(resolve => terminal.write(payload, resolve))
          }
          else { const g = readGeometry(frame.payload); terminal.resize(g.cols, g.rows) }
          if (this.disposed) throw new Error('Disposed')
          if (marker) {
            if (marker.isDisposed || marker.line < 0) this.surface.onHistoryExpired?.()
            else terminal.scrollToLine(marker.line)
          } else if (anchor !== null) terminal.scrollToLine(Math.min(anchor, terminal.buffer.active.baseY))
        } finally { marker?.dispose() }
        this.applied = batch.cursor
        return this.applied
      } finally { this.pendingBytes -= batch.bytes }
    })
    if (frame.kind === 'output') this.pendingOutput = { batch, done }
    return done.then(() => position)
  }
  dispose() { this.disposed = true }
}
