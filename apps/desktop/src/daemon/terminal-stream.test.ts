import * as checkpointCells from './serialize-checkpoint-cells'
import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { TerminalStream, STREAM_READ_BYTES } from './terminal-stream'
import { HeadlessEmulator } from './headless-emulator'
import { decodeFrame, encodeFrame, geometryPayload, MAX_PAYLOAD, readGeometry } from '../shared/terminal-stream/protocol'

function write(terminal: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise(resolve => terminal.write(data, resolve))
}
function state(terminal: Terminal) {
  const buffer = terminal.buffer.active
  return {
    cols: terminal.cols, rows: terminal.rows, type: buffer.type,
    x: buffer.cursorX, y: buffer.cursorY, base: buffer.baseY,
    lines: Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)!.translateToString(true)),
    modes: terminal.modes,
  }
}

describe('TerminalStream', () => {
  it('sequences output and resize, preserving byte offsets across UTF-8 frame boundaries', () => {
    const stream = new TerminalStream()
    const input = 'a'.repeat(MAX_PAYLOAD - 1) + '😀é'
    stream.append(input)
    stream.resize(100, 30)
    stream.append('tail')
    const frames = stream.read(stream.epoch, '0', STREAM_READ_BYTES, '0').frames.map(base64 => decodeFrame(Buffer.from(base64, 'base64')))
    expect(frames.map(frame => frame.seq)).toEqual([1n, 2n, 3n, 4n])
    expect(frames.map(frame => frame.kind)).toEqual(['output', 'output', 'resize', 'output'])
    expect(frames[2].offset).toBe(frames[1].offset)
    expect(readGeometry(frames[2].payload)).toEqual({ cols: 100, rows: 30 })
    expect(Buffer.concat(frames.filter(frame => frame.kind === 'output').map(frame => Buffer.from(frame.payload))).toString('utf8')).toBe(input + 'tail')
  })

  it('bounds retention, reports expired/future/wrong-incarnation cursors, and validates head offset', () => {
    const stream = new TerminalStream(20 * 1024)
    stream.append('a'.repeat(MAX_PAYLOAD))
    const first = stream.head
    stream.append('b'.repeat(MAX_PAYLOAD))
    expect(stream.bytes).toBeLessThanOrEqual(20 * 1024)
    expect(stream.read(stream.epoch, '0', STREAM_READ_BYTES).gap).toBe(true)
    expect(stream.read(stream.epoch, first.seq, STREAM_READ_BYTES, first.offset).gap).toBe(false)
    expect(stream.read('old incarnation', first.seq, STREAM_READ_BYTES).gap).toBe(true)
    expect(stream.read(stream.epoch, '3', STREAM_READ_BYTES).gap).toBe(true)
    expect(stream.read(stream.epoch, 'nope', STREAM_READ_BYTES).gap).toBe(true)
    expect(stream.read(stream.epoch, stream.head.seq, STREAM_READ_BYTES, '0').gap).toBe(true)
    expect(stream.read(stream.epoch, stream.head.seq, STREAM_READ_BYTES, stream.head.offset)).toEqual({ epoch: stream.epoch, frames: [], gap: false })
  })

  it('clamps reads to complete frames within 64 KiB and handles empty cursors', () => {
    const stream = new TerminalStream()
    expect(stream.read(stream.epoch, '0', STREAM_READ_BYTES, '0').gap).toBe(false)
    stream.append('a'.repeat(100 * 1024))
    const read = stream.read(stream.epoch, '0', 1000000)
    expect(read.frames.reduce((total, base64) => total + Buffer.from(base64, 'base64').length, 0)).toBeLessThanOrEqual(STREAM_READ_BYTES)
    expect(stream.read(stream.epoch, '0', 10).frames).toEqual([])
  })

  it('rejects malformed frames in both directions', () => {
    expect(() => encodeFrame({ kind: 'output', seq: 0n, offset: 0n, payload: new Uint8Array(1) })).toThrow()
    expect(() => encodeFrame({ kind: 'output', seq: 1n, offset: 0n, payload: new Uint8Array(MAX_PAYLOAD + 1) })).toThrow()
    expect(() => readGeometry(new Uint8Array(5))).toThrow()
    const frame = encodeFrame({ kind: 'resize', seq: 1n, offset: 0n, payload: geometryPayload(80, 24) })
    frame[19] = 1
    expect(() => decodeFrame(frame)).toThrow('geometry')
  })
})

describe('atomic terminal checkpoints', () => {
  it.each([
    ['CSI', '\x1b[31', 'mRED\x1b[0m'],
    ['OSC', '\x1b]0;window tit', 'le\x07VISIBLE'],
    ['OSC ST', '\x1b]0;window title\x1b', '\\VISIBLE'],
    ['OSC-7', '\x1b]7;file://host/tmp/a%20', 'b\x07VISIBLE'],
    ['compound mode', '\x1b[?2004;25', 'hVISIBLE'],
    ['CSI embedded LF', '\x1b[1\n;', '2HVISIBLE'],
    ['scroll margins', '\x1b[4;15r\x1b[15;1Hbottom', '\nSCROLLED'],
    ['origin mode', '\x1b[4;15r\x1b[?6h\x1b[12;1Hbottom', '\nSCROLLED'],
    ['saved styled cursor', '\x1b[31m\x1b[4;6H\x1b7\x1b[0m\x1b[9;2Hdifferent', '\x1b8RESTORED'],
    ['custom tab stops', '\x1b[3g\x1b[5G\x1bH\x1b[13G\x1bH\r', '\tTAB1\tTAB2'],
    ['DEC charset', '\x1b(0lqq', 'qqk\x1b(Btext'],
    ['shifted charset', '\x1b)0\x0elqq', 'qqk\x0ftext'],
    ['saved charset', '\x1b(0\x1b7\x1b(B', '\x1b8lqqk'],
    ['alternate normal cursor restoration', 'normal\x1b[31m\x1b[?1049hALT', '\x1b[?1049lBACK'],
    ['pending wrap', 'a'.repeat(80 - 0), 'WRAPPED'],
    ['alternate screen', '\x1b[?1049hALT\x1b[3', '1mRED'],
  ])('preserves %s continuation and isolates later writes/resizes', async (_name, prefix, suffix) => {
    const emulator = new HeadlessEmulator(80, 24, '/tmp')
    const expected = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 10_000 })
    const restored = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 10_000 })
    const log = new TerminalStream()
    try {
      log.append('before\r\n' + prefix)
      emulator.write('before\r\n' + prefix)
      const cursor = log.head
      const pending = emulator.getStreamSnapshotAsync()
      log.append(suffix)
      emulator.write(suffix)
      log.resize(40, 12)
      emulator.resize(40, 12)
      log.append('\r\n' + 'a'.repeat(MAX_PAYLOAD - 2) + '😀é\r\nAFTER')
      emulator.write('\r\n' + 'a'.repeat(MAX_PAYLOAD - 2) + '😀é\r\nAFTER')
      const checkpoint = await pending
      expect(checkpoint.cols).toBe(80)
      expect(checkpoint.data).not.toContain('AFTER')
      await write(restored, checkpoint.data)
      const read = log.read(log.epoch, cursor.seq, STREAM_READ_BYTES, cursor.offset)
      expect(read.gap).toBe(false)
      for (const base64 of read.frames) {
        const frame = decodeFrame(Buffer.from(base64, 'base64'))
        if (frame.kind === 'output') await write(restored, frame.payload)
        else { const size = readGeometry(frame.payload); restored.resize(size.cols, size.rows) }
      }
      await write(expected, 'before\r\n' + prefix + suffix)
      expected.resize(40, 12)
      await write(expected, '\r\n' + 'a'.repeat(MAX_PAYLOAD - 2) + '😀é\r\nAFTER')
      expect(state(restored)).toEqual(state(expected))
      const a = new SerializeAddon(); expected.loadAddon(a)
      const b = new SerializeAddon(); restored.loadAddon(b)
      expect(b.serialize()).toBe(a.serialize())
      const daemonSnapshot = await emulator.getSnapshotAsync()
      expect(daemonSnapshot.cols).toBe(40)
    } finally { emulator.dispose(); expected.dispose(); restored.dispose() }
  })

  it('rejects unsupported or oversized parser continuations, then recovers at a safe cut', async () => {
    const emulator = new HeadlessEmulator(80, 24, '/tmp')
    try {
      emulator.write('\x1bP1;2qpartial')
      await expect(emulator.getStreamSnapshotAsync()).rejects.toThrow('Unsupported')
      emulator.write('\x1b\\OK')
      await expect(emulator.getStreamSnapshotAsync()).resolves.toMatchObject({ cols: 80 })
      emulator.write('\x1b]0;' + 'a'.repeat(70_000))
      await expect(emulator.getStreamSnapshotAsync()).rejects.toThrow('Unsupported')
      emulator.write('\x07OK')
      await expect(emulator.getStreamSnapshotAsync()).resolves.toMatchObject({ cols: 80 })
    } finally { emulator.dispose() }
  })

  it.each([
    '\x1b[1"qPROTECTED',
    '\x1b(0\x1b7\x1b(B\x1b8',
  ])('explicitly rejects unsupported saved state', async input => {
    const emulator = new HeadlessEmulator(80, 24, '/tmp')
    try {
      emulator.write(input)
      await expect(emulator.getStreamSnapshotAsync()).rejects.toThrow('Unsupported terminal checkpoint')
    } finally { emulator.dispose() }
  })

  it('caps the escaped JSON response rather than only the smaller raw ANSI bytes', async () => {
    const emulator = new HeadlessEmulator(80, 24, '/tmp')
    const serialize = vi.spyOn(checkpointCells, 'serializeCheckpointCells').mockReturnValue('\x1b'.repeat(800_000))
    try { await expect(emulator.getStreamSnapshotAsync()).rejects.toThrow('byte limit') }
    finally { serialize.mockRestore(); emulator.dispose() }
  })

  it('applies resize after preceding writes have actually parsed', async () => {
    const emulator = new HeadlessEmulator(10, 4, '/tmp')
    const expected = new Terminal({ cols: 10, rows: 4, allowProposedApi: true, scrollback: 10_000 })
    const restored = new Terminal({ cols: 5, rows: 4, allowProposedApi: true, scrollback: 10_000 })
    try {
      emulator.write('1234567890ABCDEFGHIJ')
      emulator.resize(5, 4)
      emulator.write('tail')
      await write(expected, '1234567890ABCDEFGHIJ')
      expected.resize(5, 4)
      await write(expected, 'tail')
      await write(restored, (await emulator.getStreamSnapshotAsync()).data)
      expect(state(restored)).toEqual(state(expected))
    } finally { emulator.dispose(); expected.dispose(); restored.dispose() }
  })
})

it('pauses authoritative input at high water and resumes only after parsing drains', async () => {
  const pressure: boolean[] = []
  const emulator = new HeadlessEmulator(80, 24, '/tmp', paused => pressure.push(paused))
  try {
    emulator.write('a'.repeat(128 * 1024))
    expect(pressure).toEqual([true])
    expect(emulator.pendingBytes).toBe(128 * 1024)
    await emulator.getSnapshotAsync()
    expect(pressure).toEqual([true, false])
    expect(emulator.pendingBytes).toBe(0)
  } finally { emulator.dispose() }
})

it('answers cursor queries once from the authoritative parser position', async () => {
  const responses: string[] = []
  const emulator = new HeadlessEmulator(80, 24, '/tmp', undefined, response => responses.push(response))
  try {
    emulator.write('\x1b[4;17H\x1b[6')
    emulator.write('n\x1b[5n\x1b]10;?\x07')
    await emulator.getSnapshotAsync()
    expect(responses.filter(x => /R$/.test(x))).toEqual(['\x1b[4;17R'])
    expect(responses).toContain('\x1b[0n')
    expect(responses.filter(x => x.startsWith('\x1b]10;'))).toHaveLength(1)
  } finally { emulator.dispose() }
})
