import { afterEach, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { AddressInfo } from 'node:net'
import { createRelay } from './relay'

const secret = 'test-only-device-secret'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())) })
async function fixture() {
  const relay = createRelay({ secret, origins: ['https://orchestra.test'], authorize: async (token, session) => {
    if (token !== 'valid' || session !== 'session-a') throw new Error('Unauthorized')
  } })
  await new Promise<void>(resolve => relay.server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => relay.close())
  return `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
}
function next(ws: WebSocket) { return new Promise<Buffer>((resolve, reject) => {
  ws.once('message', data => resolve(Buffer.from(data as Buffer)))
  ws.once('error', reject)
}) }
async function connect(url: string, origin = 'https://orchestra.test') {
  const ws = new WebSocket(url, { origin })
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  return ws
}
it('authenticates, multiplexes binary output, and routes viewer input', async () => {
  const url = await fixture()
  const host = await connect(url + '/host')
  let received = next(host); host.send(JSON.stringify({ type: 'host', secret })); expect(JSON.parse((await received).toString()).type).toBe('host-ready')
  const viewer = await connect(url + '/viewer')
  const opened = next(host); received = next(viewer)
  viewer.send(JSON.stringify({ type: 'viewer', token: 'valid', sessionId: 'session-a' }))
  const { id } = JSON.parse((await opened).toString()); expect(id).toBe(1)
  expect(JSON.parse((await received).toString()).type).toBe('authenticated')
  const routed = Buffer.alloc(24); routed.writeUInt32BE(id); routed[4] = 1; routed[5] = 1
  received = next(viewer); host.send(routed)
  expect(await received).toEqual(routed.subarray(4))
  received = next(host); viewer.send(JSON.stringify({ type: 'claim' }))
  expect(JSON.parse((await received).toString())).toEqual({ type: 'client', id, message: { type: 'claim' } })
  received = next(viewer); host.close()
  expect(JSON.parse((await received).toString())).toMatchObject({ type: 'unavailable', reason: 'offline' })
})
it('rejects invalid authorization and disallowed origins', async () => {
  const url = await fixture()
  const ws = await connect(url + '/viewer')
  const closed = new Promise<number>(resolve => ws.once('close', resolve))
  ws.send(JSON.stringify({ type: 'viewer', token: 'wrong', sessionId: 'session-a' }))
  expect(await closed).toBe(1008)
  await expect(connect(url + '/viewer', 'https://evil.test')).rejects.toThrow('403')
})
it('does not let an unauthenticated peer replace the host', async () => {
  const url = await fixture()
  const host = await connect(url + '/host')
  const ready = next(host); host.send(JSON.stringify({ type: 'host', secret })); await ready
  const attacker = await connect(url + '/host')
  const closed = new Promise<number>(resolve => attacker.once('close', resolve))
  attacker.send(JSON.stringify({ type: 'host', secret: 'invalid' }))
  expect(await closed).toBe(1008); expect(host.readyState).toBe(WebSocket.OPEN)
})
