import { randomUUID } from 'node:crypto'
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFrame, geometryPayload, HEADER_BYTES, MAX_PAYLOAD, type Cursor } from './protocol.ts'

type Options = { cols: number; rows: number; maxBytes?: number; maxEvents?: number }
type IndexEntry = { position: number; size: number; offset: bigint }

// Exact replay from the initial grid is this spike's checkpoint. No ANSI
// snapshot is assumed to contain hidden parser state. The scratch archive and
// its index have independent hard limits; fast checkpointing is a later slice.
export class SessionLog {
  readonly epoch = randomUUID()
  readonly initial: { cols: number; rows: number }
  private file: FileHandle
  private directory: string
  private index: IndexEntry[] = []
  private bytes = 0
  private offset = 0n
  private chain: Promise<void> = Promise.resolve()
  private listeners = new Set<() => void>()
  private closed = false
  private pending = 0
  private failure: unknown
  private options: Options

  private constructor(file: FileHandle, directory: string, options: Options) {
    this.file = file; this.directory = directory; this.options = options
    this.initial = { cols: options.cols, rows: options.rows }
  }
  static async open(options: Options) {
    geometryPayload(options.cols, options.rows)
    const directory = await mkdtemp(join(tmpdir(), 'orchestra-terminal-prototype-'))
    const file = await open(join(directory, 'events.bin'), 'w+')
    return new SessionLog(file, directory, options)
  }
  get head(): Cursor { return { seq: String(this.index.length), offset: String(this.offset) } }
  get metrics() { return { events: this.index.length, archiveBytes: this.bytes, pendingBytes: this.pending } }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  validCursor(cursor: Cursor): boolean {
    if (!/^\d{1,20}$/.test(cursor.seq) || !/^\d{1,20}$/.test(cursor.offset)) return false
    const seq = BigInt(cursor.seq)
    if (seq < 0n || seq > BigInt(this.index.length)) return false
    return BigInt(cursor.offset) === (seq === 0n ? 0n : this.index[Number(seq) - 1].offset)
  }
  append(data: Uint8Array): Promise<void> { return this.enqueue('output', data) }
  resize(cols: number, rows: number, apply: () => void = () => {}): Promise<void> {
    return this.enqueue('resize', geometryPayload(cols, rows), apply)
  }
  private enqueue(kind: 'output' | 'resize', data: Uint8Array, apply?: () => void): Promise<void> {
    if (this.closed || this.failure) return Promise.reject(new Error('Session closed or archive failed'))
    if (this.pending + data.length > 1024 * 1024) return Promise.reject(new Error('Producer exceeded pending byte limit'))
    const copy = data.slice()
    this.pending += copy.length
    const task = this.chain.then(async () => {
      if (this.failure) throw this.failure
      const count = Math.ceil(copy.length / MAX_PAYLOAD)
      if (this.bytes + copy.length + count * HEADER_BYTES > (this.options.maxBytes ?? 64 * 1024 * 1024) || this.index.length + count > (this.options.maxEvents ?? 20000)) throw new Error('Prototype archive limit reached')
      for (let start = 0; start < copy.length; start += MAX_PAYLOAD) {
        const payload = copy.subarray(start, start + MAX_PAYLOAD)
        const offset = this.offset + (kind === 'output' ? BigInt(payload.length) : 0n)
        const frame = encodeFrame({ kind, seq: BigInt(this.index.length + 1), offset, payload })
        let written = 0
        while (written < frame.length) {
          const result = await this.file.write(frame, written, frame.length - written, this.bytes + written)
          if (!result.bytesWritten) throw new Error('Archive write made no progress')
          written += result.bytesWritten
        }
        this.index.push({ position: this.bytes, size: frame.length, offset })
        this.bytes += frame.length; this.offset = offset
        apply?.()
        for (const listener of this.listeners) listener()
      }
    }).catch(error => { this.failure = error; throw error }).finally(() => { this.pending -= copy.length })
    this.chain = task.catch(() => {})
    return task
  }
  async read(seq: bigint): Promise<Uint8Array | undefined> {
    if (seq < 1n || seq > BigInt(this.index.length)) return undefined
    const entry = this.index[Number(seq) - 1]
    const bytes = new Uint8Array(entry.size)
    let read = 0
    while (read < bytes.length) {
      const result = await this.file.read(bytes, read, bytes.length - read, entry.position + read)
      if (!result.bytesRead) throw new Error('Truncated archive')
      read += result.bytesRead
    }
    return bytes
  }
  async close() {
    if (this.closed) return
    this.closed = true
    await this.chain
    this.listeners.clear()
    await this.file.close()
    await rm(this.directory, { recursive: true, force: true })
  }
}
