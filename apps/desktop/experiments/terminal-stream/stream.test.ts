import { afterEach, expect, test } from 'vitest'
import { SessionLog } from './session.ts'
import { Terminal } from '@xterm/headless'
import { TerminalApplier } from './client.ts'
import { decodeFrame, encodeFrame, readGeometry } from './protocol.ts'

const sessions: SessionLog[] = []
afterEach(async () => { await Promise.all(sessions.splice(0).map(s => s.close())) })

test('an attached viewer can read output produced before it connected', async () => {
  const session = await SessionLog.open({ cols: 100, rows: 30 })
  sessions.push(session)
  await session.append(new TextEncoder().encode('before attach\r\n'))
  expect(await session.read(1n)).toBeInstanceOf(Uint8Array)
  const frame = decodeFrame((await session.read(1n))!)
  expect(new TextDecoder().decode(frame.payload)).toBe('before attach\r\n')
  expect(frame.offset).toBe(15n)
})

test('the applied cursor waits for the terminal parser and preserves split Unicode across resume', async () => {
  const session = await SessionLog.open({ cols: 100, rows: 30 })
  sessions.push(session)
  const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
  try {
    const applier = new TerminalApplier(term)
    const data = new TextEncoder().encode('A🙂Z')
    await session.append(data.subarray(0, 3))
    await session.append(data.subarray(3))
    const first = applier.accept((await session.read(1n))!)
    expect(applier.cursor.seq).toBe('0')
    await first
    expect(applier.cursor).toEqual({ seq: '1', offset: '3' })
    await applier.accept((await session.read(2n))!)
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('A🙂Z')
    expect(applier.cursor).toEqual({ seq: '2', offset: '6' })
  } finally { term.dispose() }
})

test('a gap is rejected before any later VT bytes reach the terminal', async () => {
  const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
  try {
    const applier = new TerminalApplier(term)
    await expect(applier.accept(encodeFrame({ kind: 'output', seq: 2n, offset: 1n, payload: new TextEncoder().encode('X') }))).rejects.toThrow('gap')
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('')
  } finally { term.dispose() }
})

test('late replay preserves long history, split escape state and ordered resize', async () => {
  const session = await SessionLog.open({ cols: 100, rows: 30 })
  sessions.push(session)
  const term = new Terminal({ cols: 100, rows: 30, scrollback: 10000, allowProposedApi: true })
  try {
    const output = Array.from({ length: 5000 }, (_, i) => `row-${i}\r\n`).join('')
    await session.append(new TextEncoder().encode(output + '\x1b[3'))
    await session.append(new TextEncoder().encode('1mRED\x1b[0m'))
    await session.resize(60, 20)
    const applier = new TerminalApplier(term)
    for (let seq = 1n; seq <= BigInt(session.head.seq); seq++) await applier.accept((await session.read(seq))!)
    expect(term.cols).toBe(60)
    expect(term.rows).toBe(20)
    expect(term.buffer.active.getLine(1000)?.translateToString(true)).toBe('row-1000')
    expect(term.buffer.active.getLine(5000)?.translateToString(true)).toBe('RED')
    expect(term.buffer.active.getLine(5000)?.getCell(0)?.getFgColor()).toBe(1)
    const resize = decodeFrame((await session.read(BigInt(session.head.seq)))!)
    expect(resize.kind).toBe('resize')
    expect(readGeometry(resize.payload)).toEqual({ cols: 60, rows: 20 })
  } finally { term.dispose() }
})

test('replaying a duplicate frame cannot duplicate terminal content', async () => {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  try {
    const applier = new TerminalApplier(term)
    const frame = encodeFrame({ kind: 'output', seq: 1n, offset: 2n, payload: new TextEncoder().encode('OK') })
    await applier.accept(frame)
    await applier.accept(frame)
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('OK')
  } finally { term.dispose() }
})

test('archive limits refuse new output without corrupting the retained prefix', async () => {
  const session = await SessionLog.open({ cols: 80, rows: 24, maxBytes: 25 })
  sessions.push(session)
  await session.append(new TextEncoder().encode('hello'))
  await expect(session.append(new TextEncoder().encode('too much'))).rejects.toThrow('archive limit')
  expect(session.head).toEqual({ seq: '1', offset: '5' })
  expect(new TextDecoder().decode(decodeFrame((await session.read(1n))!).payload)).toBe('hello')
})

test('a correct sequence with an incorrect byte offset is rejected before parsing', async () => {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  try {
    const applier = new TerminalApplier(term)
    await expect(applier.accept(encodeFrame({ kind: 'output', seq: 1n, offset: 9n, payload: new TextEncoder().encode('X') }))).rejects.toThrow('offset gap')
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('')
  } finally { term.dispose() }
})
