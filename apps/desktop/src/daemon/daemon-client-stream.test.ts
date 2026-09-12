import { afterEach, describe, expect, it, vi } from 'vitest'

const daemon = vi.hoisted(() => ({ version: undefined as number | undefined, requests: [] as Record<string, unknown>[] }))
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../main/persistence', () => ({ getStoreFilePath: vi.fn() }))
vi.mock('../main/native-chat/store', () => ({ NativeChatStore: class {} }))
vi.mock('../main/native-chat/terminal-migration', () => ({ migrateTerminalConversation: vi.fn(), isIdleTerminalShell: vi.fn() }))
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
          ...(request.type === 'readTerminalStream' ? { stream: { epoch: 'epoch', frames: [], gap: false } } : {}),
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

afterEach(() => { vi.useRealTimers(); daemon.requests = []; daemon.version = undefined })

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
