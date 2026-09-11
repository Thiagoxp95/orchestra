import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const os = vi.hoisted(() => ({
  pid: 4242 as number | null,
  alive: true,
  killError: null as string | null,
  pidReadError: null as string | null,
  probe: 'connect' as 'connect' | 'error' | 'hang',
  signals: [] as Array<string | number | undefined>,
  spawn: vi.fn(), unlink: vi.fn(), close: vi.fn(), destroy: vi.fn(),
}))
vi.mock('../daemon/protocol', () => ({ DAEMON_DIR: '/mock/daemon', DAEMON_SOCKET_PATH: '/mock/socket', DAEMON_PID_PATH: '/mock/pid', DAEMON_META_PATH: '/mock/meta' }))
vi.mock('./node-runtime', () => ({ resolveNodeExecPath: () => '/new/node', buildNodeChildEnv: (env: unknown) => env }))
vi.mock('node:fs', () => ({
  readFileSync(path: string) {
    if (path === '/mock/pid') {
      if (os.pidReadError || os.pid === null) throw Object.assign(new Error('Cannot read PID'), { code: os.pidReadError ?? 'ENOENT' })
      return String(os.pid)
    }
    if (path === '/mock/meta') return JSON.stringify({ nodeExecPath: '/old/node', codeSignature: 'old-version' })
    return Buffer.from('new bundled daemon')
  },
  mkdirSync: vi.fn(), openSync: () => 99, closeSync: os.close, unlinkSync: os.unlink,
}))
vi.mock('node:child_process', () => ({ spawn: os.spawn }))
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events')
  return { createConnection() {
    const socket = Object.assign(new EventEmitter(), { destroy: os.destroy })
    const outcome = os.probe
    void Promise.resolve().then(() => {
      if (outcome === 'connect') socket.emit('connect')
      else if (outcome === 'error') socket.emit('error', new Error('Connection refused'))
    })
    return socket
  } }
})

beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules(); vi.clearAllMocks()
  os.pid = 4242; os.alive = true; os.killError = null; os.pidReadError = null; os.probe = 'connect'; os.signals = []
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0) {
      if (os.killError || !os.alive) throw Object.assign(new Error('Cannot probe process'), { code: os.killError ?? 'ESRCH' })
      return true
    }
    // No real process signals are ever sent by this suite.
    os.signals.push(signal)
    os.alive = false
    return true
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  os.spawn.mockImplementation(() => {
    os.alive = true; os.pid = 4242; os.probe = 'connect'
    return { on: vi.fn(), unref: vi.fn() }
  })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('safe daemon attachment', () => {
  it('defers code/runtime upgrades without sending any terminating signal or replacing a healthy daemon', async () => {
    const { ensureDaemon } = await import('./daemon-launcher')
    const first = ensureDaemon()
    await vi.advanceTimersByTimeAsync(5000)
    await first
    expect(os.signals).toEqual([])
    expect(os.spawn).not.toHaveBeenCalled()
    expect(os.unlink).not.toHaveBeenCalled()
    await ensureDaemon()
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).toMatch(/defer/i)
  })

  it.each(['error', 'hang'] as const)('preserves a live daemon and its socket when the connection probe %s', async probe => {
    os.probe = probe
    const { ensureDaemon } = await import('./daemon-launcher')
    const result = ensureDaemon().catch(error => error)
    await vi.advanceTimersByTimeAsync(8000)
    expect(await result).toMatchObject({ message: expect.stringMatching(/still running|alive/i) })
    expect(os.signals).toEqual([])
    expect(os.spawn).not.toHaveBeenCalled()
    expect(os.unlink).not.toHaveBeenCalled()
    // The same application can retry successfully after a transient outage.
    os.probe = 'connect'
    await expect(ensureDaemon()).resolves.toBeUndefined()
  })

  it.each(['EPERM', 'EACCES'])('does not treat an inconclusive process probe (%s) as a dead daemon', async code => {
    os.probe = 'error'; os.killError = code
    const { ensureDaemon } = await import('./daemon-launcher')
    const result = ensureDaemon().catch(error => error)
    await vi.advanceTimersByTimeAsync(8000)
    expect(await result).toBeInstanceOf(Error)
    expect(os.spawn).not.toHaveBeenCalled()
    expect(os.unlink).not.toHaveBeenCalled()
    expect(os.signals).toEqual([])
  })

  it('reuses a reachable daemon even when its PID file is missing', async () => {
    os.pid = null
    const { ensureDaemon } = await import('./daemon-launcher')
    const result = ensureDaemon()
    await vi.advanceTimersByTimeAsync(5000)
    await result
    expect(os.spawn).not.toHaveBeenCalled()
    expect(os.unlink).not.toHaveBeenCalled()
  })

  it('refuses replacement when the PID metadata cannot be read safely', async () => {
    os.pidReadError = 'EACCES'; os.probe = 'error'
    const { ensureDaemon } = await import('./daemon-launcher')
    const result = ensureDaemon().catch(error => error)
    await vi.advanceTimersByTimeAsync(8000)
    expect(await result).toBeInstanceOf(Error)
    expect(os.spawn).not.toHaveBeenCalled()
    expect(os.unlink).not.toHaveBeenCalled()
  })

  it('coalesces simultaneous startup after confirming the tracked daemon is dead', async () => {
    os.alive = false; os.probe = 'error'
    const { ensureDaemon } = await import('./daemon-launcher')
    const results = Promise.all([ensureDaemon(), ensureDaemon(), ensureDaemon()])
    await vi.advanceTimersByTimeAsync(5000)
    await results
    expect(os.spawn).toHaveBeenCalledTimes(1)
    expect(os.unlink.mock.calls.map(([path]) => path)).toEqual(['/mock/socket', '/mock/pid', '/mock/meta'])
    expect(os.signals).toEqual([])
    expect(os.close).toHaveBeenCalledWith(99)
  })

  it('starts a fresh daemon when neither a process nor a socket exists', async () => {
    os.pid = null; os.alive = false; os.probe = 'error'
    const { ensureDaemon } = await import('./daemon-launcher')
    const result = ensureDaemon()
    await vi.advanceTimersByTimeAsync(5000)
    await result
    expect(os.spawn).toHaveBeenCalledTimes(1)
    expect(os.signals).toEqual([])
  })

  it('retains a spawned child identity when startup times out before its PID file is written', async () => {
    os.pid = null; os.alive = false; os.probe = 'error'
    os.spawn.mockImplementation(() => {
      os.alive = true
      return { pid: 9876, on: vi.fn(), unref: vi.fn() }
    })
    const { ensureDaemon } = await import('./daemon-launcher')
    const first = ensureDaemon().catch(error => error)
    await vi.advanceTimersByTimeAsync(6000)
    expect(await first).toBeInstanceOf(Error)
    const retry = ensureDaemon().catch(error => error)
    await vi.advanceTimersByTimeAsync(6000)
    expect(await retry).toMatchObject({ message: expect.stringMatching(/still running/i) })
    expect(os.spawn).toHaveBeenCalledTimes(1)
    expect(os.unlink).toHaveBeenCalledTimes(3)
    expect(os.signals).toEqual([])
  })

  it('releases probe timers after a healthy connection', async () => {
    const { ensureDaemon } = await import('./daemon-launcher')
    await ensureDaemon()
    expect(vi.getTimerCount()).toBe(0)
    expect(os.destroy).toHaveBeenCalledTimes(1)
  })
})
