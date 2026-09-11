import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const env = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>, cleanups: [] as Array<() => void>,
  terminals: [] as Array<{ cols: number; rows: number; writes: Array<{ text: string; cols: number; rows: number }>; resize(cols: number, rows: number): void }>,
  create: vi.fn(), resize: vi.fn(), snapshot: undefined as undefined | ((id: string, snapshot: unknown) => void),
  parsed: [] as Array<() => void>,
  data: undefined as undefined | ((id: string, data: string) => void),
  subscribers: [] as Array<(state: unknown) => void>,
  state: { maestroMode: false, remoteGeometryOwner: 'desktop' as 'desktop' | 'web', remoteGeometry: null as null | { cols: number; rows: number }, sessions: {}, agentLaunches: {} },
}))
vi.mock('react', () => ({ useRef: (value: unknown) => ({ current: value }), useEffect: (effect: () => void) => { env.effects.push(effect) } }))
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; writes: Array<{ text: string; cols: number; rows: number }> = []
  constructor() { env.terminals.push(this) }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
  write(text: string, done?: () => void) { this.writes.push({ text, cols: this.cols, rows: this.rows }); if (done) env.parsed.push(done) }
  open() {} loadAddon() {} attachCustomKeyEventHandler() {} onData() { return { dispose() {} } } reset() {} dispose() {} focus() {}
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }))
vi.mock('./terminal-webgl', () => ({ enableTerminalWebgl() {} }))
vi.mock('./terminal-autofit', () => ({ attachTerminalAutoFit: (term: { resize(cols: number, rows: number): void }, _fit: unknown, _container: unknown, options: { isPaused(): boolean; onSize(geo: { cols: number; rows: number }): void }) => ({
  reconcile() { if (!options.isPaused()) { term.resize(120, 40); options.onSize({ cols: 120, rows: 40 }) } }, dispose() {},
}) }))
vi.mock('../store/app-store', () => ({ useAppStore: { getState: () => env.state, subscribe: (listener: (state: unknown) => void) => { env.subscribers.push(listener); return () => {} } } }))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
let fontReady: ReturnType<typeof deferred<unknown[]>>
function element() { return { style: {}, appendChild() {}, remove() {}, clientWidth: 1000, clientHeight: 800, offsetWidth: 1000, offsetHeight: 800 } }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules(); vi.clearAllMocks()
  env.effects = []; env.cleanups = []; env.terminals = []; env.parsed = []; env.snapshot = undefined; env.data = undefined; env.subscribers = []; env.state.remoteGeometryOwner = 'desktop'; env.state.remoteGeometry = null
  fontReady = deferred<unknown[]>()
  const doc = { createElement: element, fonts: { load: () => fontReady.promise, ready: fontReady.promise } }
  const api = { createTerminal: env.create, resizeTerminal: env.resize, onTerminalData: (listener: typeof env.data) => { env.data = listener; return () => {} }, onTerminalSnapshot: (listener: typeof env.snapshot) => { env.snapshot = listener; return () => {} } }
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', { electronAPI: api, addEventListener() {}, removeEventListener() {}, requestAnimationFrame: (cb: () => void) => setTimeout(cb, 16), cancelAnimationFrame: clearTimeout })
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  env.create.mockResolvedValue({ success: true, restoredSnapshot: false })
})
afterEach(() => { env.cleanups.forEach(cleanup => cleanup()); vi.useRealTimers(); vi.unstubAllGlobals() })
async function mount() {
  const { useTerminal } = await import('./useTerminal')
  useTerminal('agent', '/repo', { current: element() as unknown as HTMLDivElement }, undefined, 'claude', undefined, true)
  env.effects.forEach(effect => { const cleanup = effect(); if (cleanup) env.cleanups.push(cleanup) })
}
describe('desktop agent startup geometry', () => {
  it('waits for terminal fonts and layout, then launches once at the fitted grid', async () => {
    await mount()
    expect(env.create).not.toHaveBeenCalled()
    fontReady.resolve([])
    await vi.advanceTimersByTimeAsync(40)
    expect(env.create).toHaveBeenCalledTimes(1)
    expect(env.create.mock.calls[0][1]).toMatchObject({ cols: 120, rows: 40 })
  })
  it('parses a restored snapshot at its own grid before fitting the live terminal', async () => {
    env.create.mockImplementation(async () => {
      env.snapshot?.('agent', { cols: 80, rows: 24, snapshotAnsi: 'saved prompt', rehydrateSequences: '' })
      return { success: true, restoredSnapshot: true }
    })
    await mount(); fontReady.resolve([]); await vi.advanceTimersByTimeAsync(60)
    const term = env.terminals[0]
    expect(term.writes.find(write => write.text.includes('saved prompt'))).toMatchObject({ cols: 80, rows: 24 })
    expect(term.cols).toBe(80)
    env.parsed.splice(0).forEach(done => done())
    await vi.advanceTimersByTimeAsync(20)
    expect(term.cols).toBe(120)
  })
})

it('bounds missing font readiness so hidden/background panes can start', async () => {
  await mount()
  await vi.advanceTimersByTimeAsync(700)
  expect(env.create).toHaveBeenCalledTimes(1)
  expect(env.create.mock.calls[0][1]).toMatchObject({ cols: 120, rows: 40 })
})
it('does not launch after disposal while waiting for fonts or layout', async () => {
  await mount()
  env.cleanups.splice(0).forEach(cleanup => cleanup())
  fontReady.resolve([])
  await vi.advanceTimersByTimeAsync(1000)
  expect(env.create).not.toHaveBeenCalled()
  expect(env.resize).not.toHaveBeenCalled()
})
it('does not resize after disposal while snapshot parsing is pending', async () => {
  env.create.mockImplementation(async () => {
    env.snapshot?.('agent', { cols: 80, rows: 24, snapshotAnsi: 'saved prompt' })
    return { success: true, restoredSnapshot: true }
  })
  await mount(); fontReady.resolve([]); await vi.advanceTimersByTimeAsync(60)
  const resizes = env.resize.mock.calls.length
  env.cleanups.splice(0).forEach(cleanup => cleanup())
  env.parsed.splice(0).forEach(done => done())
  await vi.advanceTimersByTimeAsync(100)
  expect(env.resize).toHaveBeenCalledTimes(resizes)
  expect(env.create).toHaveBeenCalledTimes(1)
})
it('still reattaches a terminal when activated after the first attachment completes', async () => {
  await mount(); fontReady.resolve([]); await vi.advanceTimersByTimeAsync(60)
  expect(env.create).toHaveBeenCalledTimes(1)
  const cleanup = env.effects[1]()
  if (cleanup) env.cleanups.push(cleanup)
  await vi.advanceTimersByTimeAsync(20)
  expect(env.create).toHaveBeenCalledTimes(2)
  expect(env.create.mock.calls[1][1]).toMatchObject({ cols: 120, rows: 40 })
})

it('defers a phone geometry handoff until snapshot parsing has finished', async () => {
  env.create.mockImplementation(async () => {
    env.snapshot?.('agent', { cols: 80, rows: 24, snapshotAnsi: 'saved prompt' })
    return { success: true, restoredSnapshot: true }
  })
  await mount(); fontReady.resolve([]); await vi.advanceTimersByTimeAsync(60)
  env.state.remoteGeometryOwner = 'web'; env.state.remoteGeometry = { cols: 50, rows: 30 }
  env.subscribers.forEach(listener => listener(env.state))
  expect(env.terminals[0].cols).toBe(80)
  env.parsed.splice(0).forEach(done => done())
  await vi.advanceTimersByTimeAsync(20)
  expect(env.terminals[0].cols).toBe(50)
})
it('continues showing live output after a failed reattach', async () => {
  await mount(); fontReady.resolve([]); await vi.advanceTimersByTimeAsync(60)
  env.create.mockImplementation(async () => { env.data?.('agent', 'output during reconnect'); throw new Error('connection reset') })
  const cleanup = env.effects[1](); if (cleanup) env.cleanups.push(cleanup)
  await vi.advanceTimersByTimeAsync(40)
  expect(env.terminals[0].writes.some(write => write.text.includes('output during reconnect'))).toBe(true)
})

it('drains warm-agent bytes at the live source grid before the desktop resize', async () => {
  env.create.mockImplementation(async () => {
    env.snapshot?.('agent', { cols: 80, rows: 24, snapshotAnsi: 'saved prompt' })
    return { success: true, restoredSnapshot: true, liveGeometry: { cols: 80, rows: 24 } }
  })
  await mount(); fontReady.resolve([]); await vi.advanceTimersByTimeAsync(60)
  env.data?.('agent', 'live cursor update')
  env.parsed.splice(0).forEach(done => done())
  await vi.advanceTimersByTimeAsync(20)
  expect(env.terminals[0].writes.find(write => write.text === 'live cursor update')).toMatchObject({ cols: 80, rows: 24 })
  env.parsed.splice(0).forEach(done => done())
  await vi.advanceTimersByTimeAsync(20)
  expect(env.terminals[0].cols).toBe(120)
})
it('uses the new PTY grid for live bytes following a historical cold snapshot', async () => {
  env.create.mockImplementation(async () => {
    env.snapshot?.('agent', { cols: 80, rows: 24, snapshotAnsi: 'old history' })
    return { success: true, restoredSnapshot: true, liveGeometry: { cols: 120, rows: 40 } }
  })
  await mount(); fontReady.resolve([]); await vi.advanceTimersByTimeAsync(60)
  env.data?.('agent', 'new process output')
  env.parsed.splice(0).forEach(done => done())
  await vi.advanceTimersByTimeAsync(20)
  expect(env.terminals[0].writes.find(write => write.text === 'new process output')).toMatchObject({ cols: 120, rows: 40 })
})
it('does not reset or replay the same snapshot on normal live reactivation', async () => {
  await mount(); fontReady.resolve([]); await vi.advanceTimersByTimeAsync(60)
  env.create.mockImplementation(async () => {
    env.snapshot?.('agent', { cols: 120, rows: 40, snapshotAnsi: 'duplicate snapshot' })
    return { success: true, restoredSnapshot: true }
  })
  const cleanup = env.effects[1](); if (cleanup) env.cleanups.push(cleanup)
  await vi.advanceTimersByTimeAsync(60)
  expect(env.terminals[0].writes.some(write => write.text.includes('duplicate snapshot'))).toBe(false)
})
