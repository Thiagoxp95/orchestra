import { createRequire } from 'node:module'
import { afterEach, expect, test, vi } from 'vitest'
import { TerminalApplier } from './applier'
import { encodeFrame, geometryPayload } from '../../../../desktop/src/shared/terminal-stream/protocol'

const require = createRequire(new URL('../../../../desktop/package.json', import.meta.url))
const { Terminal } = require('@xterm/headless')
afterEach(() => vi.useRealTimers())

test('a burst of tiny frames catches up without a parser timer for every frame', async () => {
  vi.useFakeTimers()
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const applier = new TerminalApplier({
    current: () => terminal,
    stage: () => ({ terminal, commit() {}, dispose() {} }),
  })
  try {
    const seed = applier.seed({ epoch: 'realtime', seq: '0', offset: '0', cols: 80, rows: 24, data: '', historyExpired: false })
    await vi.advanceTimersByTimeAsync(10)
    await seed
    // A network burst may split even UTF-8 and ANSI sequences across frames.
    const bytes = new TextEncoder().encode('x'.repeat(1000) + '\r\x1b[2K🐱 Working: 5s')
    const applied = Array.from(bytes, (byte, i) => applier.frame(encodeFrame({
      kind: 'output', seq: BigInt(i + 1), offset: BigInt(i + 1), payload: new Uint8Array([byte]),
    })))
    await vi.advanceTimersByTimeAsync(250)
    expect(applier.applied.seq).toBe(String(bytes.length))
    await Promise.all(applied)
    expect(applier.pendingBytes).toBe(0)
    expect(terminal.buffer.active.getLine(terminal.buffer.active.cursorY).translateToString(true)).toBe('🐱 Working: 5s')
  } finally { applier.dispose(); terminal.dispose() }
})

test('coalesced output keeps resize boundaries and parser-completed resume cursors', async () => {
  vi.useFakeTimers()
  const terminal = new Terminal({ cols: 4, rows: 3, allowProposedApi: true })
  const applier = new TerminalApplier({
    current: () => terminal,
    stage: () => ({ terminal, commit() {}, dispose() {} }),
  })
  try {
    const seed = applier.seed({ epoch: 'resize', seq: '0', offset: '0', cols: 4, rows: 3, data: '', historyExpired: false })
    await vi.advanceTimersByTimeAsync(10); await seed
    const output = (seq: number, offset: number, data: string) => applier.frame(encodeFrame({
      kind: 'output', seq: BigInt(seq), offset: BigInt(offset), payload: new TextEncoder().encode(data),
    }))
    const pending = [output(1, 2, 'ab'), output(2, 4, 'cd')]
    pending.push(applier.frame(encodeFrame({ kind: 'resize', seq: 3n, offset: 4n, payload: geometryPayload(8, 3) })))
    pending.push(output(4, 6, 'ef'), output(5, 8, 'gh'))
    expect(applier.applied).toEqual({ seq: '0', offset: '0' })
    await vi.advanceTimersByTimeAsync(50)
    expect(await Promise.all(pending)).toEqual([
      { seq: '1', offset: '2' }, { seq: '2', offset: '4' }, { seq: '3', offset: '4' },
      { seq: '4', offset: '6' }, { seq: '5', offset: '8' },
    ])
    expect(applier.applied).toEqual({ seq: '5', offset: '8' })
    expect(terminal.cols).toBe(8)
    expect(terminal.buffer.active.getLine(0).translateToString(true)).toBe('abcdefgh')
    expect(applier.pendingBytes).toBe(0)
  } finally { applier.dispose(); terminal.dispose() }
})
