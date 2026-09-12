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

/** Parser completion, rather than network receipt, is the resumable cursor. */
export class TerminalApplier {
  epoch: string | null = null
  applied: Cursor = { seq: '0', offset: '0' }
  pendingBytes = 0
  private received: Cursor = this.applied
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false
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
    return this.enqueue(async () => {
      try {
        if (this.disposed) throw new Error('Disposed')
        const terminal = this.surface.current()
        const buffer = terminal.buffer.active
        const anchor = buffer.type !== 'alternate' && buffer.viewportY < buffer.baseY ? buffer.viewportY : null
        const marker = anchor === null ? undefined : terminal.registerMarker?.(anchor - buffer.baseY - (buffer.cursorY ?? 0))
        try {
          if (frame.kind === 'output') await new Promise<void>(resolve => terminal.write(frame.payload, resolve))
          else { const g = readGeometry(frame.payload); terminal.resize(g.cols, g.rows) }
          if (this.disposed) throw new Error('Disposed')
          if (marker) {
            if (marker.isDisposed || marker.line < 0) this.surface.onHistoryExpired?.()
            else terminal.scrollToLine(marker.line)
          } else if (anchor !== null) terminal.scrollToLine(Math.min(anchor, terminal.buffer.active.baseY))
        } finally { marker?.dispose() }
        this.applied = { seq: String(frame.seq), offset: String(frame.offset) }
        return this.applied
      } finally { this.pendingBytes -= bytes.byteLength }
    })
  }
  dispose() { this.disposed = true }
}
