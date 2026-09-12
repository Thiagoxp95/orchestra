import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { SessionLog } from './session.ts'
import { createRelay } from './relay.ts'
import { decodeFrame } from './protocol.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 1500
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}

async function setup(windowBytes = 20000) {
  const session = await SessionLog.open({ cols: 100, rows: 30 })
  const server = createServer()
  const relay = createRelay(server, session, { token: 'test-token', windowBytes })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  cleanup.push(async () => { relay.close(); await new Promise<void>(resolve => server.close(() => resolve())); await session.close() })
  async function viewer(cursor = { seq: '0', offset: '0' }, epoch: string | null = null, expectReady = true) {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/stream?token=test-token`, { origin: `http://127.0.0.1:${address.port}`, handshakeTimeout: 400 })
    const frames: Uint8Array[] = []
    const messages: Record<string, unknown>[] = []
    ws.on('message', (data, binary) => { if (binary) frames.push(new Uint8Array(data as Buffer)); else messages.push(JSON.parse(data.toString())) })
    cleanup.push(async () => { ws.terminate() })
    await once(ws, 'open')
    ws.send(JSON.stringify({ type: 'attach', epoch, ...cursor }))
    await until(() => messages.some(m => m.type === (expectReady ? 'ready' : 'error')))
    return { ws, frames, messages }
  }
  return { session, viewer }
}

test('a viewer reconnects at its applied offset without replaying earlier output', async () => {
  const { session, viewer } = await setup()
  await session.append(new TextEncoder().encode('first'))
  const first = await viewer()
  await until(() => first.frames.length === 1)
  first.ws.close()
  await session.append(new TextEncoder().encode('second'))
  const resumed = await viewer({ seq: '1', offset: '5' }, session.epoch)
  await until(() => resumed.frames.length === 1)
  const frame = decodeFrame(resumed.frames[0])
  expect(frame.seq).toBe(2n)
  expect(new TextDecoder().decode(frame.payload)).toBe('second')
})

test('a cursor from another PTY incarnation is refused', async () => {
  const { viewer } = await setup()
  const stale = await viewer({ seq: '0', offset: '0' }, 'previous-pty', false)
  expect(stale.messages.some(m => String(m.message).includes('incarnation'))).toBe(true)
  expect(stale.frames).toHaveLength(0)
})

test('an acknowledgement for unsent output closes the connection', async () => {
  const { viewer } = await setup()
  const invalid = await viewer()
  invalid.ws.send(JSON.stringify({ type: 'ack', seq: '99', offset: '99' }))
  await until(() => invalid.messages.some(m => m.type === 'error'))
  expect(invalid.messages.some(m => String(m.message).includes('unsent'))).toBe(true)
})

test('only the current lease can resize the shared session', async () => {
  const { session, viewer } = await setup()
  const a = await viewer(); const b = await viewer()
  a.ws.send(JSON.stringify({ type: 'claim' }))
  await until(() => a.messages.some(m => m.type === 'lease' && m.controller === true))
  const oldLease = a.messages.findLast(m => m.type === 'lease')!.lease
  b.ws.send(JSON.stringify({ type: 'claim' }))
  await until(() => b.messages.some(m => m.type === 'lease' && m.controller === true))
  a.ws.send(JSON.stringify({ type: 'resize', lease: oldLease, id: 1, cols: 40, rows: 10 }))
  await until(() => a.messages.some(m => m.type === 'denied'))
  expect(session.head.seq).toBe('0')
  b.ws.send(JSON.stringify({ type: 'resize', lease: b.messages.findLast(m => m.type === 'lease')!.lease, id: 1, cols: 60, rows: 20 }))
  await until(() => b.messages.some(m => m.type === 'input-ack'))
  expect(decodeFrame((await session.read(1n))!).kind).toBe('resize')
})

test('a slow viewer exhausts only its own window while another viewer continues', async () => {
  const { session, viewer } = await setup()
  const slow = await viewer()
  const fast = await viewer()
  fast.ws.on('message', (data, binary) => {
    if (!binary) return
    const frame = decodeFrame(new Uint8Array(data as Buffer))
    fast.ws.send(JSON.stringify({ type: 'ack', seq: String(frame.seq), offset: String(frame.offset) }))
  })
  await session.append(new Uint8Array(60000).fill(65))
  await until(() => fast.frames.length === 4)
  expect(slow.frames).toHaveLength(1)
  const first = decodeFrame(slow.frames[0])
  slow.ws.send(JSON.stringify({ type: 'ack', seq: String(first.seq), offset: String(first.offset) }))
  await until(() => slow.frames.length === 2)
})
