import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { TerminalStreamHost, type StreamDaemon } from '../../desktop/src/main/terminal-stream-host'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.reverse()) cleanup(); cleanups.length = 0; vi.useRealTimers() })
const turn = () => delay(20)
const daemon: StreamDaemon = {
  supportsTerminalStream: () => true,
  getTerminalStreamCheckpoint: async () => { throw new Error('No viewer') },
  readTerminalStream: async () => { throw new Error('No viewer') },
  write: () => {}, resize: async () => {},
}
async function fixture(upgrade: boolean, acknowledge: boolean, pong = true) {
  const server = createServer()
  const wss = new WebSocketServer({ noServer: true, autoPong: pong })
  let connections = 0
  server.on('upgrade', (request, socket, head) => {
    connections++
    if (upgrade) wss.handleUpgrade(request, socket, head, ws => {
      ws.on('message', () => { if (acknowledge) ws.send(JSON.stringify({ type: 'host-ready', protocol: 1 })) })
    })
    else cleanups.push(() => socket.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.close() })
  const host = new TerminalStreamHost({ daemon, secret: 'test-secret', endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, onGeometry: () => {} })
  cleanups.push(() => host.dispose())
  await turn()
  return { host, connections: () => connections, drop: () => { for (const ws of wss.clients) ws.terminate() } }
}

test.each([[false, false], [true, false]])('retries a stalled relay handshake (upgrade=%s, ready=%s) within 6 seconds', async (upgrade, ready) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const f = await fixture(upgrade, ready)
  expect(f.connections()).toBe(1)
  await vi.advanceTimersByTimeAsync(6000)
  await turn()
  expect(f.connections()).toBeGreaterThanOrEqual(2)
})

test('reconnects a silent established relay and recovers immediately on desktop wake', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const f = await fixture(true, true, false)
  await vi.advanceTimersByTimeAsync(16000)
  await turn()
  expect(f.connections()).toBeGreaterThanOrEqual(2)
  const beforeWake = f.connections()
  f.host.resume()
  await turn()
  expect(f.connections()).toBe(beforeWake + 1)
  f.host.dispose()
  f.host.resume()
  await vi.advanceTimersByTimeAsync(60000)
  await turn()
  expect(f.connections()).toBe(beforeWake + 1)
})

test('an established host retries a dropped socket without waiting for backoff', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const f = await fixture(true, true)
  f.drop()
  await turn()
  await vi.advanceTimersByTimeAsync(0)
  await turn()
  expect(f.connections()).toBe(2)
})

test('detects a silent established host transport within eight seconds', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const f = await fixture(true, true, false)
  await vi.advanceTimersByTimeAsync(8001)
  await turn()
  expect(f.connections()).toBeGreaterThanOrEqual(2)
})
