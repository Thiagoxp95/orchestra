import { afterEach, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { AddressInfo } from 'node:net'
import { createRelay } from './relay'
import { TerminalStreamHost, type StreamDaemon } from '../../desktop/src/main/terminal-stream-host'
import { encodeFrame } from '../../desktop/src/shared/terminal-stream/protocol'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0 })
async function until(predicate: () => boolean) {
  const end = Date.now() + 3000
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 5)) }
}
async function fixture(supported = true) {
  const secret = 'test-only-device-secret'
  const relay = createRelay({ secret, origins: ['https://test.local'], authorize: async () => {} })
  await new Promise<void>(r => relay.server.listen(0, '127.0.0.1', r))
  cleanups.push(() => relay.close())
  const endpoint = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
  const frames: string[] = []
  let offset = 0
  const writes: string[] = [], resizes: string[] = [], geometry: string[] = []
  const daemon: StreamDaemon = {
    supportsTerminalStream: () => supported,
    getTerminalStreamCheckpoint: async () => ({ epoch: 'incarnation', seq: '0', offset: '0', cols: 80, rows: 24, data: 'seed' }),
    readTerminalStream: async (_session, epoch, seq, maxBytes, afterOffset) => {
      const n = Number(seq)
      let bytes = 0
      const batch: string[] = []
      for (const frame of frames.slice(n)) {
        bytes += Buffer.from(frame, 'base64').length
        if (bytes > maxBytes) break
        batch.push(frame)
      }
      return { epoch: 'incarnation', frames: batch, gap: epoch !== 'incarnation' || afterOffset !== String(n * 16000) }
    },
    write: (_session, data) => { writes.push(data) },
    resize: async (session, cols, rows) => { resizes.push(`${session}:${cols}x${rows}`) },
  }
  const host = new TerminalStreamHost({ daemon, secret, endpoint, onGeometry: (session, value) => { geometry.push(`${session}:${value?.cols ?? 'desktop'}`) } })
  cleanups.push(() => host.dispose())
  await until(() => (host as unknown as { socket: WebSocket }).socket?.readyState === WebSocket.OPEN)
  await new Promise(r => setTimeout(r, 20))
  async function viewer(sessionId: string) {
    const ws = new WebSocket(endpoint + '/viewer', { origin: 'https://test.local' })
    const messages: any[] = [], binary: Buffer[] = []
    ws.on('message', (data, isBinary) => { if (isBinary) binary.push(Buffer.from(data as Buffer)); else messages.push(JSON.parse(data.toString())) })
    await new Promise<void>(r => ws.once('open', r))
    const send = (m: unknown) => ws.send(JSON.stringify(m))
    send({ type: 'viewer', token: 'test', sessionId })
    await until(() => messages.some(m => m.type === 'authenticated'))
    return { ws, messages, binary, send }
  }
  return { host, viewer, writes, resizes, geometry, output(count: number) {
    for (let i = 0; i < count; i++) {
      offset += 16000
      frames.push(Buffer.from(encodeFrame({ kind: 'output', seq: BigInt(frames.length + 1), offset: BigInt(offset), payload: Buffer.alloc(16000, 120) })).toString('base64'))
    }
  } }
}
async function attach(v: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['viewer']>>) {
  v.send({ type: 'attach', epoch: null, seq: '0', offset: '0' })
  await until(() => v.messages.some(m => m.type === 'seed'))
  v.send({ type: 'ack', seq: '0', offset: '0' })
  await until(() => v.messages.some(m => m.type === 'ready'))
}
it('waits for seed parse acknowledgement and isolates slow viewers at byte window', async () => {
  const f = await fixture()
  const slow = await f.viewer('a'), fast = await f.viewer('a')
  slow.send({ type: 'attach', epoch: null, seq: '0', offset: '0' })
  await until(() => slow.messages.some(m => m.type === 'seed'))
  f.output(10)
  await attach(fast)
  await until(() => fast.binary.length === 4)
  expect(slow.binary).toHaveLength(0)
  fast.send({ type: 'ack', seq: '4', offset: '64000' })
  await until(() => fast.binary.length === 8)
  slow.send({ type: 'ack', seq: '0', offset: '0' })
  await until(() => slow.binary.length === 4)
  fast.send({ type: 'ack', seq: '8', offset: '128000' })
  await until(() => fast.binary.length === 10)
  expect(slow.binary).toHaveLength(4)
  fast.send({ type: 'ack', seq: '4', offset: '64000' })
  await new Promise(r => setTimeout(r, 30))
  expect(fast.messages.some(m => m.type === 'error')).toBe(false)
})
it('leases isolate sessions and stale controllers cannot resize or write', async () => {
  const f = await fixture()
  const a = await f.viewer('a'), b = await f.viewer('a'), c = await f.viewer('b')
  for (const v of [a, b, c]) await attach(v)
  a.send({ type: 'claim' }); c.send({ type: 'claim' })
  await until(() => a.messages.some(m => m.type === 'lease' && m.controller))
  const leaseA = a.messages.filter(m => m.type === 'lease' && m.controller).at(-1).lease
  a.send({ type: 'resize', lease: leaseA, id: 1, cols: 53, rows: 24 })
  await until(() => f.resizes.length === 1)
  expect(f.resizes).toEqual(['a:53x24']); expect(f.host.geometry('b')).toBeUndefined()
  b.send({ type: 'claim' })
  await until(() => b.messages.some(m => m.type === 'lease' && m.controller))
  a.send({ type: 'input', lease: leaseA, id: 2, data: 'must not arrive' })
  await until(() => a.messages.some(m => m.type === 'denied'))
  expect(f.writes).toEqual([])
  const leaseB = b.messages.filter(m => m.type === 'lease' && m.controller).at(-1).lease
  b.send({ type: 'input', lease: leaseB, id: 1, data: 'once' })
  b.send({ type: 'input', lease: leaseB, id: 1, data: 'once' })
  await until(() => f.writes.length === 1)
  expect(f.writes).toEqual(['once'])
  a.send({ type: 'claim' })
  await until(() => a.messages.filter(m => m.type === 'lease' && m.controller).length === 2)
  const regained = a.messages.filter(m => m.type === 'lease' && m.controller).at(-1).lease
  a.send({ type: 'input', lease: regained, id: 3, data: 'after reclaim' })
  await until(() => f.writes.length === 2)
  expect(f.writes).toEqual(['once', 'after reclaim'])
})
it('announces old daemon compatibility without invoking unsupported RPCs', async () => {
  const f = await fixture(false)
  const v = await f.viewer('a')
  await until(() => v.messages.some(m => m.type === 'unavailable'))
  expect(v.messages.find(m => m.type === 'unavailable').reason).toBe('unsupported')
})

it('binds delayed input to its original lease through handoff and reacquisition', async () => {
  const f = await fixture()
  const a = await f.viewer('a'), b = await f.viewer('a')
  await attach(a); await attach(b)
  a.send({ type: 'claim' })
  await until(() => a.messages.some(m => m.type === 'lease' && m.controller))
  const original = a.messages.filter(m => m.type === 'lease' && m.controller).at(-1)
  expect(typeof original.token).toBe('string')
  const pending = f.host.captureInputGuard('a', original.token)
  expect(() => pending()).not.toThrow()
  expect(() => f.host.captureInputGuard('a')).toThrow('control changed')
  b.send({ type: 'claim' })
  await until(() => b.messages.some(m => m.type === 'lease' && m.controller))
  expect(() => pending()).toThrow('control changed')
  a.send({ type: 'claim' })
  await until(() => a.messages.filter(m => m.type === 'lease' && m.controller).length === 2)
  expect(() => pending()).toThrow('control changed')
  expect(() => f.host.captureInputGuard('a', original.token)).toThrow('control changed')
})
