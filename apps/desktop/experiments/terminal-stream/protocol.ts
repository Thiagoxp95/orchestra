// Prototype wire format: version, kind, uint64 event sequence, uint64 output
// byte offset, payload. Resize is in the same sequence as output.
export const HEADER_BYTES = 18
export const MAX_PAYLOAD = 16 * 1024
export type Cursor = { seq: string; offset: string }
export type Frame = { kind: 'output' | 'resize'; seq: bigint; offset: bigint; payload: Uint8Array }

export function encodeFrame(frame: Frame): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES + frame.payload.length)
  const view = new DataView(bytes.buffer)
  view.setUint8(0, 1)
  view.setUint8(1, frame.kind === 'output' ? 1 : 2)
  view.setBigUint64(2, frame.seq)
  view.setBigUint64(10, frame.offset)
  bytes.set(frame.payload, HEADER_BYTES)
  return bytes
}

export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length < HEADER_BYTES || bytes.length > HEADER_BYTES + MAX_PAYLOAD) throw new Error('Invalid frame size')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kind = view.getUint8(1)
  if (view.getUint8(0) !== 1 || (kind !== 1 && kind !== 2)) throw new Error('Unsupported frame')
  if (kind === 2 && bytes.length !== HEADER_BYTES + 4) throw new Error('Invalid resize')
  return { kind: kind === 1 ? 'output' : 'resize', seq: view.getBigUint64(2), offset: view.getBigUint64(10), payload: bytes.subarray(HEADER_BYTES) }
}

export function geometryPayload(cols: number, rows: number): Uint8Array {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 200) throw new Error('Invalid geometry')
  const bytes = new Uint8Array(4)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, cols)
  view.setUint16(2, rows)
  return bytes
}

export function readGeometry(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const cols = view.getUint16(0); const rows = view.getUint16(2)
  geometryPayload(cols, rows)
  return { cols, rows }
}
