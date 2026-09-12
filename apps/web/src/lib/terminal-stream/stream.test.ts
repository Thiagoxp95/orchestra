import { createRequire } from 'node:module'
import { bindTerminalInput } from '../../../../desktop/src/shared/terminal-stream/user-input'
import { afterEach, expect, test, vi } from 'vitest'
import { TerminalApplier, type TerminalSink } from './applier'
import { TerminalConnection, type StreamSocket } from './connection'
import { encodeFrame, geometryPayload } from '../../../../desktop/src/shared/terminal-stream/protocol'
class Sink implements TerminalSink {
  events: unknown[] = []; callbacks: (() => void)[] = []
  buffer = { active: { baseY: 100, viewportY: 20, type: 'normal' } }
  write(data: string | Uint8Array, callback: () => void) { this.events.push(data); this.callbacks.push(callback) }
  resize(cols: number, rows: number) { this.events.push({ cols, rows }) }
  scrollToLine(line: number) { this.buffer.active.viewportY = line }
  flush() { this.callbacks.shift()?.() }
}
const seed = { epoch: 'epoch-a', seq: '5', offset: '20', cols: 80, rows: 24, data: 'checkpoint', historyExpired: false }
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function setup() {
  let visible = new Sink(); const stages: Sink[] = []
  const applier = new TerminalApplier({ current: () => visible, stage: () => {
    const terminal = new Sink(); stages.push(terminal)
    return { terminal, commit: () => { visible = terminal }, dispose: () => {} }
  } })
  return { applier, stages, current: () => visible }
}
async function hydrate(s: ReturnType<typeof setup>) {
  const p = s.applier.seed(seed); await tick(); s.stages[0].flush(); await p
}
test('checkpoint keeps old view until parsed and seeds at recorded geometry', async () => {
  const s = setup(); const old = s.current(); const p = s.applier.seed(seed); await tick()
  expect(s.current()).toBe(old); expect(s.stages[0].events).toEqual([{ cols: 80, rows: 24 }, 'checkpoint'])
  expect(s.applier.epoch).toBe(null)
  s.stages[0].flush(); await p
  expect(s.current()).toBe(s.stages[0]); expect(s.applier.applied).toEqual({ seq: '5', offset: '20' })
})
test('parser callback commits output before ordered resize and keeps absolute reading line', async () => {
  const s = setup(); await hydrate(s)
  const p = s.applier.frame(encodeFrame({ kind: 'output', seq: 6n, offset: 23n, payload: new TextEncoder().encode('abc') }))
  const r = s.applier.frame(encodeFrame({ kind: 'resize', seq: 7n, offset: 23n, payload: geometryPayload(90, 30) }))
  await tick(); expect(s.applier.applied.seq).toBe('5'); expect(s.current().events).not.toContainEqual({ cols: 90, rows: 30 })
  s.current().buffer.active.baseY = 120; s.current().flush(); await p; await r
  expect(s.applier.applied).toEqual({ seq: '7', offset: '23' }); expect(s.current().buffer.active.viewportY).toBe(20)
})
test('rejects gaps and bounds queued live bytes including in-flight parser data', async () => {
  const s = setup(); await hydrate(s)
  expect(() => s.applier.frame(encodeFrame({ kind: 'output', seq: 7n, offset: 21n, payload: new Uint8Array(1) }))).toThrow(/gap/i)
  for (let i = 0; i < 7; i++) void s.applier.frame(encodeFrame({ kind: 'output', seq: BigInt(6+i), offset: BigInt(20+(i+1)*16384), payload: new Uint8Array(16384) }))
  expect(() => s.applier.frame(encodeFrame({ kind: 'output', seq: 13n, offset: 131092n, payload: new Uint8Array(16384) }))).toThrow(/pending/i)
})
class Socket implements StreamSocket {
  readyState = 1; bufferedAmount = 0; binaryType = 'arraybuffer'
  onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: Record<string, unknown>[] = []
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3; this.onclose?.() }
  message(data: unknown) { this.onmessage?.({ data: typeof data === 'object' && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data }) }
}
function connect(s = setup()) {
  const sockets: Socket[] = []; const unsupported = vi.fn(); const statuses: string[] = []
  const connection = new TerminalConnection({ token: 'token', sessionId: 'session', applier: s.applier, socketFactory: () => { const ws = new Socket(); sockets.push(ws); return ws }, onUnsupported: unsupported, onStatus: status => statuses.push(status) })
  connection.start(); return { ...s, connection, sockets, unsupported, statuses }
}
afterEach(() => vi.useRealTimers())
test('authenticates before attach, acks after seed parse, claims only on activation, and debounces leased resize', async () => {
  vi.useFakeTimers(); const s = connect(); const ws = s.sockets[0]; ws.onopen?.()
  expect(ws.sent).toEqual([{ type: 'viewer', token: 'token', sessionId: 'session', waitForHost: true }])
  ws.message({ type: 'authenticated' }); await tick(); expect(ws.sent.at(-1)).toEqual({ type: 'attach', epoch: null, seq: '0', offset: '0' })
  ws.message({ type: 'seed', ...seed }); await tick(); expect(ws.sent.some(x => x.type === 'ack')).toBe(false)
  s.stages[0].flush(); await tick(); expect(ws.sent.at(-1)).toEqual({ type: 'ack', seq: '5', offset: '20' })
  ws.message({ type: 'ready', epoch: 'epoch-a' }); expect(ws.sent.at(-1)).toEqual({ type: 'claim' })
  ws.message({ type: 'lease', controller: true, lease: 2 }); s.connection.resize(90, 30); s.connection.resize(100, 40)
  vi.advanceTimersByTime(119); expect(ws.sent.some(x => x.type === 'resize')).toBe(false)
  vi.advanceTimersByTime(1); expect(ws.sent.at(-1)).toEqual({ type: 'resize', lease: 2, id: 1, cols: 100, rows: 40 })
  expect(s.connection.input('🐱'.repeat(1100))).toBe(true)
  expect(ws.sent.filter(x => x.type === 'input').map(x => new TextEncoder().encode(String(x.data)).length)).toEqual([4096,304])
  ws.message({ type: 'lease', controller: false, lease: 3 }); const count = ws.sent.length
  expect(s.connection.input('no')).toBe(false); s.connection.resize(80,24); vi.advanceTimersByTime(120); expect(ws.sent).toHaveLength(count)
  s.connection.dispose()
})
test('reconnect waits for parser drain and attaches from applied cursor without replaying input', async () => {
  vi.useFakeTimers(); const s = setup(); await hydrate(s); const c = connect(s); const ws = c.sockets[0]
  ws.onopen?.(); ws.message({ type: 'authenticated' }); await tick(); ws.message({ type: 'ready', epoch: 'epoch-a' })
  ws.message(encodeFrame({ kind: 'output', seq: 6n, offset: 23n, payload: new TextEncoder().encode('abc') }).buffer)
  await tick(); ws.close(); vi.advanceTimersByTime(1000); await tick(); expect(c.sockets).toHaveLength(1)
  s.current().flush(); await tick(); vi.advanceTimersByTime(1000); await tick()
  const next = c.sockets[1]; next.onopen?.(); next.message({ type: 'authenticated' }); await tick()
  expect(next.sent.at(-1)).toEqual({ type: 'attach', epoch: 'epoch-a', seq: '6', offset: '23' }); expect(s.stages).toHaveLength(1)
  c.connection.dispose()
})
test('only explicit unsupported falls back, including before authentication', async () => {
  vi.useFakeTimers(); const s = connect(); s.sockets[0].message({ type: 'unavailable', reason: 'offline' }); await tick()
  expect(s.unsupported).not.toHaveBeenCalled(); s.connection.dispose()
  const old = connect(); old.sockets[0].message({ type: 'unavailable', reason: 'unsupported' }); await tick()
  expect(old.unsupported).toHaveBeenCalledOnce(); expect(old.sockets[0].readyState).toBe(3); old.connection.dispose()
})
test('replacement checkpoint restores a retained reading line by its content after history expiration', async () => {
  const old = new Sink()
  const replacement = new Sink()
  const oldLines = { ...old.buffer.active, getLine: (line: number) => ({ translateToString: () => line === 20 ? 'reading here' : `old-${line}` }) }
  old.buffer.active = oldLines
  replacement.buffer.active = { ...replacement.buffer.active, getLine: (line: number) => ({ translateToString: () => line === 8 ? 'reading here' : `new-${line}` }) } as typeof oldLines
  let visible = old
  const applier = new TerminalApplier({ current: () => visible, stage: () => ({ terminal: replacement, commit: () => { visible = replacement }, dispose: () => {} }) })
  const p = applier.seed({ ...seed, historyExpired: true }); await tick(); replacement.flush(); await p
  expect(visible.buffer.active.viewportY).toBe(8)
})
test('checkpoint rejects unsafe geometry before creating a staged terminal', () => {
  const s = setup()
  expect(() => s.applier.seed({ ...seed, cols: 501 })).toThrow(/geometry/i)
  expect(s.stages).toHaveLength(0)
})
test('lease revisions keep input ids monotonic and a passive lease never automatically reclaims', async () => {
  const s = setup(); await hydrate(s); const c = connect(s); const ws = c.sockets[0]
  ws.onopen?.(); ws.message({ type: 'authenticated' }); ws.message({ type: 'ready', epoch: seed.epoch })
  ws.message({ type: 'lease', lease: 1, controller: true }); c.connection.input('one')
  ws.message({ type: 'lease', lease: 2, controller: false }); const claims = ws.sent.filter(x => x.type === 'claim').length
  expect(c.connection.input('lost')).toBe(false)
  expect(ws.sent.filter(x => x.type === 'claim')).toHaveLength(claims)
  c.connection.claim(); ws.message({ type: 'lease', lease: 3, controller: true }); c.connection.input('two')
  expect(ws.sent.filter(x => x.type === 'input')).toEqual([{ type: 'input', lease: 1, id: 1, data: 'one' }, { type: 'input', lease: 3, id: 2, data: 'two' }])
  c.connection.dispose()
})
test('expired checkpoint notification waits for committed hydration', async () => {
  const s = setup(); const expired = vi.fn(); const ws = new Socket()
  const c = new TerminalConnection({ token: 'token', sessionId: 'session', applier: s.applier, socketFactory: () => ws, onHistoryExpired: expired })
  c.start(); ws.onopen?.(); ws.message({ type: 'authenticated' }); ws.message({ type: 'seed', ...seed, historyExpired: true }); await tick()
  expect(expired).not.toHaveBeenCalled(); s.stages[0].flush(); await tick(); expect(expired).toHaveBeenCalledOnce()
  c.dispose()
})
test('retained reading line follows marker when output trims a full 10,000-line scrollback', async () => {
  const s = setup(); await hydrate(s)
  const sink = s.current()
  sink.buffer.active = { baseY: 10000, viewportY: 9000, type: 'normal', cursorY: 23 } as typeof sink.buffer.active
  const marker = { line: 9000, isDisposed: false, dispose: vi.fn() }
  const registerMarker = vi.fn(() => marker)
  Object.assign(sink, { registerMarker })
  const p = s.applier.frame(encodeFrame({ kind: 'output', seq: 6n, offset: 23n, payload: new TextEncoder().encode('abc') })); await tick()
  // xterm discards 100 oldest lines while retaining the same visible content.
  marker.line = 8900; sink.buffer.active.viewportY = 8900; sink.flush(); await p
  expect(registerMarker).toHaveBeenCalledWith(-1023)
  expect(sink.buffer.active.viewportY).toBe(8900); expect(marker.dispose).toHaveBeenCalledOnce()
})
test('reports reading history expiration when xterm trims away the anchored line', async () => {
  const sink = new Sink(); const expired = vi.fn()
  const marker = { line: -1, isDisposed: true, dispose: vi.fn() }
  Object.assign(sink, { registerMarker: () => marker })
  const applier = new TerminalApplier({ current: () => sink, stage: () => ({ terminal: sink, commit: () => {}, dispose: () => {} }), onHistoryExpired: expired })
  const seeded = applier.seed(seed); await tick(); sink.flush(); await seeded
  const p = applier.frame(encodeFrame({ kind: 'output', seq: 6n, offset: 23n, payload: new TextEncoder().encode('abc') })); await tick(); sink.flush(); await p
  expect(expired).toHaveBeenCalledOnce()
})
test('xterm query replies never become user stream input, including CPR, DA, color and DCS', async () => {
  const require = createRequire(new URL('../../../../desktop/package.json', import.meta.url))
  const { Terminal } = require('@xterm/headless')
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const s = setup(); await hydrate(s); const c = connect(s); const ws = c.sockets[0]
  ws.onopen?.(); ws.message({ type: 'authenticated' }); ws.message({ type: 'ready', epoch: seed.epoch })
  ws.message({ type: 'lease', lease: 1, controller: true })
  const replies: string[] = []
  const unbind = bindTerminalInput(term, { user: data => c.connection.input(data), response: data => replies.push(data) })
  await new Promise<void>(resolve => term.write('\x1b[4;17H\x1b[6n\x1b[5n\x1b[c\x1b[>c\x1b]10;?\x07\x1bP$qm\x1b\\', resolve))
  expect(replies).toContain('\x1b[4;17R')
  expect(replies).toContain('\x1b[0n')
  expect(replies).toContain('\x1b[?1;2c')
  expect(replies.some(reply => reply.startsWith('\x1bP'))).toBe(true)
  // Headless has no renderer-owned palette; exercise that same onData source.
  term._core.coreService.triggerDataEvent('\x1b]10;rgb:ffff/ffff/ffff\x1b\\')
  expect(replies).toContain('\x1b]10;rgb:ffff/ffff/ffff\x1b\\')
  expect(ws.sent.filter(x => x.type === 'input')).toEqual([])
  // Public input(..., true) is xterm's real keyboard/IME/paste provenance.
  term.input('hello', true)
  term.input('\x1b[1;2R', true) // Shift-F3 shares CPR's bytes.
  term.input('\x1b[0n', true) // User-supplied status-like literal.
  c.connection.input('\x1b[?1;2c') // Explicit clipboard path is also literal.
  expect(ws.sent.filter(x => x.type === 'input').map(x => x.data)).toEqual(['hello', '\x1b[1;2R', '\x1b[0n', '\x1b[?1;2c'])
  await new Promise<void>(resolve => term.write('\x1b[6n', resolve))
  expect(ws.sent.filter(x => x.type === 'input')).toHaveLength(4)
  unbind(); term.input('after disposal', true)
  expect(ws.sent.filter(x => x.type === 'input')).toHaveLength(4)
  term.dispose(); c.connection.dispose()
})
test('ancillary lease proof is exposed only for the current active controller', async () => {
  const s = setup(); await hydrate(s); const c = connect(s); const ws = c.sockets[0]
  ws.onopen?.(); ws.message({ type: 'authenticated' }); ws.message({ type: 'ready', epoch: seed.epoch })
  ws.message({ type: 'lease', lease: 1, controller: true, token: 'first' })
  expect(c.connection.inputLease).toBe('first')
  c.connection.setActive(false); expect(c.connection.inputLease).toBeUndefined()
  c.connection.setActive(true); expect(c.connection.inputLease).toBeUndefined()
  await tick()
  const next = c.sockets[1]; next.onopen?.(); next.message({ type: 'authenticated' }); next.message({ type: 'ready', epoch: seed.epoch })
  next.message({ type: 'lease', lease: 2, controller: false }); expect(c.connection.inputLease).toBeUndefined()
  next.message({ type: 'lease', lease: 3, controller: true, token: 'next' }); expect(c.connection.inputLease).toBe('next')
  next.close(); expect(c.connection.inputLease).toBeUndefined(); c.connection.dispose()
})

test('foreground bypasses reconnect backoff and replaces a half-open terminal without replaying input', async () => {
  vi.useFakeTimers(); const s = setup(); await hydrate(s); const c = connect(s); const old = c.sockets[0]
  old.onopen?.(); old.message({ type: 'authenticated' }); old.message({ type: 'ready', epoch: seed.epoch })
  old.message({ type: 'lease', lease: 1, controller: true })
  c.connection.input('before sleep')
  c.connection.setActive(false)
  vi.advanceTimersByTime(2000)
  c.connection.setActive(true)
  await tick()
  expect(c.sockets).toHaveLength(2)
  expect(old.readyState).toBe(3)
  const next = c.sockets[1]
  next.onopen?.(); next.message({ type: 'authenticated' })
  expect(next.sent.at(-1)).toEqual({ type: 'attach', epoch: seed.epoch, seq: '5', offset: '20' })
  expect(next.sent.some(m => m.type === 'input')).toBe(false)
  next.close(); await tick()
  c.connection.setActive(false); c.connection.setActive(true); await tick()
  expect(c.sockets).toHaveLength(3)
  vi.advanceTimersByTime(1000); await tick()
  expect(c.sockets).toHaveLength(3)
  c.connection.dispose()
})

test('keeps a waiting relay connected and detects a silent stream without a browser close event', async () => {
  vi.useFakeTimers(); const s = connect(); const ws = s.sockets[0]
  ws.onopen?.(); ws.message({ type: 'waiting', heartbeat: true })
  for (let i = 0; i < 3; i++) {
    vi.advanceTimersByTime(10000)
    expect(ws.sent.at(-1)).toEqual({ type: 'ping' })
    ws.message({ type: 'pong' })
  }
  expect(s.sockets).toHaveLength(1)
  expect(ws.readyState).toBe(1)
  vi.advanceTimersByTime(15000); await tick(); vi.advanceTimersByTime(500); await tick()
  expect(s.sockets).toHaveLength(2)
  s.connection.dispose()
})

test('resume event bursts wait for in-flight parsing and open only one replacement', async () => {
  vi.useFakeTimers(); const s = setup(); await hydrate(s); const c = connect(s); const old = c.sockets[0]
  old.message({ type: 'authenticated' }); old.message({ type: 'ready', epoch: seed.epoch })
  old.message(encodeFrame({ kind: 'output', seq: 6n, offset: 23n, payload: new TextEncoder().encode('abc') }).buffer)
  await tick()
  c.connection.resume(); c.connection.resume(); c.connection.start()
  await tick(); expect(c.sockets).toHaveLength(1)
  s.current().flush(); await tick()
  expect(c.sockets).toHaveLength(2)
  c.sockets[1].onopen?.(); c.sockets[1].message({ type: 'authenticated' })
  expect(c.sockets[1].sent.at(-1)).toEqual({ type: 'attach', epoch: seed.epoch, seq: '6', offset: '23' })
  c.connection.dispose(); c.connection.resume()
  vi.advanceTimersByTime(60000); await tick()
  expect(c.sockets).toHaveLength(2)
})
