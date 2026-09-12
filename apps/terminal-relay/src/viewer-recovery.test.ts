import type { AddressInfo } from 'node:net'
import { afterEach, expect, test, vi } from 'vitest'
import WebSocket from 'ws'
import { createRelay } from './relay'
import { TerminalStreamHost, type StreamDaemon } from '../../desktop/src/main/terminal-stream-host'
import { encodeFrame } from '../../desktop/src/shared/terminal-stream/protocol'
import { TerminalApplier, type TerminalSink } from '../../web/src/lib/terminal-stream/applier'
import { TerminalConnection, type StreamSocket } from '../../web/src/lib/terminal-stream/connection'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; vi.restoreAllMocks() })
function deadline<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done, reject) => {
    resolve = done
    const timer = setTimeout(() => reject(new Error('Terminal did not recover')), 2000)
    cleanups.push(() => clearTimeout(timer))
  })
  return { promise, resolve }
}

test('catch-up output crosses the real host and relay without disconnecting or losing the next input', async () => {
  // Keep all delivery in the same rate-limit window, independent of CI speed.
  vi.spyOn(Date, 'now').mockReturnValue(1000)
  const secret = 'test-only-device-secret'
  const relay = createRelay({ secret, origins: ['https://test.local'], authorize: async () => {} })
  await new Promise<void>(resolve => relay.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => relay.close())
  const endpoint = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
  const frames = Array.from({ length: 600 }, (_, i) => Buffer.from(encodeFrame({
    kind: 'output', seq: BigInt(i + 1), offset: BigInt(i + 1), payload: new Uint8Array([120]),
  })).toString('base64'))
  const input = deadline<string>()
  const daemon: StreamDaemon = {
    supportsTerminalStream: () => true,
    getTerminalStreamCheckpoint: async () => ({ epoch: 'test', seq: '0', offset: '0', cols: 80, rows: 24, data: '' }),
    readTerminalStream: async (_session, epoch, seq, maxBytes) => ({ epoch: 'test', gap: epoch !== 'test', frames: frames.slice(Number(seq), Number(seq) + Math.floor(maxBytes / 19)) }),
    write: (_session, data) => input.resolve(data),
    resize: async () => {},
  }
  const host = new TerminalStreamHost({ daemon, secret, endpoint, onGeometry: () => {} })
  cleanups.push(() => host.dispose())
  let visibleBytes = 0
  const sink: TerminalSink = {
    buffer: { active: { baseY: 0, viewportY: 0 } }, resize() {}, scrollToLine() {},
    write(data, done) { visibleBytes += data.length; done() },
  }
  const applier = new TerminalApplier({ current: () => sink, stage: () => ({ terminal: sink, commit() {}, dispose() {} }) })
  cleanups.push(() => applier.dispose())
  const caughtUp = deadline<void>()
  const controlled = deadline<void>()
  const sockets: WebSocket[] = []
  const connection = new TerminalConnection({
    token: 'test', sessionId: 'test', url: endpoint, applier,
    socketFactory: url => {
      const ws = new WebSocket(url, { origin: 'https://test.local' }); sockets.push(ws)
      return ws as unknown as StreamSocket
    },
    onApplied: () => { if (applier.applied.seq === '600') caughtUp.resolve() },
    onController: active => { if (active) controlled.resolve() },
  })
  cleanups.push(() => connection.dispose())
  connection.start()
  await Promise.all([caughtUp.promise, controlled.promise])
  expect(connection.input('after catch-up')).toBe(true)
  expect(await input.promise).toBe('after catch-up')
  expect(visibleBytes).toBe(600)
  expect(sockets).toHaveLength(1)
  expect(sockets[0].readyState).toBe(WebSocket.OPEN)
})
