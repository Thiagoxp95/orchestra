import { afterEach, describe, expect, it, vi } from 'vitest'

const daemon = vi.hoisted(() => ({ version: undefined as number | undefined, requests: [] as Record<string, unknown>[], reads: [] as string[][] }))
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../main/persistence', () => ({ getStoreFilePath: vi.fn() }))
vi.mock('../main/daemon-launcher', () => ({ ensureDaemon: vi.fn() }))
vi.mock('../main/interruption-popup', () => ({ closeInterruptionPopup: vi.fn(), forwardToPopup: vi.fn() }))
vi.mock('../main/terminal-output-buffer', () => ({ feedTerminalOutput: vi.fn(), markWorkingStart: vi.fn() }))
vi.mock('../main/process-monitor', () => ({ getSessionStatus: vi.fn() }))
vi.mock('../main/idle-notifier', () => ({ noteAgentWorking: vi.fn(), notifyTerminalAttention: vi.fn(), setSessionNotificationTitle: vi.fn() }))
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events')
  return ({
  createConnection: () => {
    class Socket extends EventEmitter {
      connecting = true
      setEncoding() {}
      destroy() { this.emit('close') }
      write(line: string) {
        const request = JSON.parse(line)
        daemon.requests.push(request)
        if (request.id !== undefined) queueMicrotask(() => this.emit('data', JSON.stringify({
          id: request.id, ok: true,
          ...(request.type === 'hello' && daemon.version !== undefined ? { terminalStreamVersion: daemon.version } : {}),
          ...(request.type === 'getTerminalStreamCheckpoint' ? { checkpoint: { epoch: 'epoch', seq: '0', offset: '0', cols: 80, rows: 24, data: '' } } : {}),
          ...(request.type === 'readTerminalStream' ? { stream: { epoch: 'epoch', frames: daemon.reads.shift() ?? [], gap: false } } : {}),
        }) + '\n'))
        return true
      }
    }
    const socket = new Socket()
    queueMicrotask(() => { socket.connecting = false; socket.emit('connect') })
    return socket
  },
})
})

import { DaemonClient } from '../main/daemon-client'
import { encodeFrame } from '../shared/terminal-stream/protocol'

afterEach(() => { vi.useRealTimers(); daemon.requests = []; daemon.reads = []; daemon.version = undefined })

describe('daemon stream capability handshake', () => {
  it('keeps old daemons connected and explicitly unsupported', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const client = new DaemonClient()
    await client.reconnect()
    expect(client.supportsTerminalStream()).toBe(false)
    await expect(client.getTerminalStreamCheckpoint('session')).rejects.toThrow('does not support')
    expect(daemon.requests.some(request => request.type === 'getTerminalStreamCheckpoint')).toBe(false)
    client.disconnect()
  })

  it('captures version 1, exposes typed RPCs, and clears support on reconnect to an old daemon', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    daemon.version = 1
    const client = new DaemonClient()
    await client.reconnect()
    expect(client.supportsTerminalStream()).toBe(true)
    expect(await client.getTerminalStreamCheckpoint('session')).toMatchObject({ epoch: 'epoch', seq: '0' })
    expect(await client.readTerminalStream('session', 'epoch', '0', 65536, '0')).toMatchObject({ gap: false })
    expect(daemon.requests.at(-1)).toMatchObject({ type: 'readTerminalStream', afterOffset: '0' })
    daemon.version = undefined
    await client.reconnect()
    expect(client.supportsTerminalStream()).toBe(false)
    client.disconnect()
  })
})

describe('title taps for sessions this client never attached', () => {
  const titleFrame = (seq: bigint, title: string) =>
    Buffer.from(encodeFrame({ kind: 'output', seq, offset: seq * 100n, payload: Buffer.from(`\x1b]0;${title}\x07`) })).toString('base64')
  const window = { isDestroyed: () => false, webContents: { send: vi.fn() } }

  it('settles an interrupted turn to idle from the pulled title stream', async () => {
    daemon.version = 1
    const client = new DaemonClient()
    await client.connect(window as never)
    const states: string[] = []
    client.addClaudeWorkStateHandler((_id, state) => states.push(state))

    await client.pollTitleTaps(['s1']) // seeds at the stream head
    expect(daemon.requests.at(-1)).toMatchObject({ type: 'getTerminalStreamCheckpoint', sessionId: 's1' })
    daemon.reads.push([titleFrame(1n, '◐ Working')])
    await client.pollTitleTaps(['s1'])
    expect(client.getClaudeWorkState('s1')).toBe('working')

    vi.useFakeTimers({ toFake: ['setTimeout'] })
    daemon.reads.push([titleFrame(2n, '✳ Working')])
    await client.pollTitleTaps(['s1'])
    // Each poll resumes where the last frame left off, then drains until empty.
    expect(daemon.requests.filter((r) => r.type === 'readTerminalStream').map((r) => r.afterSeq)).toEqual(['0', '1', '1', '2'])
    vi.advanceTimersByTime(4000)
    expect(states).toEqual(['working', 'idle'])
    client.disconnect()
  })

  it('leaves attached sessions to the pushed data events', async () => {
    daemon.version = 1
    const client = new DaemonClient()
    await client.connect(window as never)
    await client.createOrAttach('s1', { cwd: '/', cols: 80, rows: 24 })
    const before = daemon.requests.length
    await client.pollTitleTaps(['s1'])
    expect(daemon.requests.length).toBe(before)
    client.disconnect()
  })
})
