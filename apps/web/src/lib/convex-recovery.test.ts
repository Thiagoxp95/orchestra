import { afterEach, expect, test, vi } from 'vitest'
import { ConvexReactClient } from 'convex/react'
import { anyApi } from 'convex/server'

class Socket extends EventTarget {
  static CONNECTING = 0 as const; static OPEN = 1 as const; static CLOSING = 2 as const; static CLOSED = 3 as const
  static sockets: Socket[] = []
  readyState = 0; bufferedAmount = 0; binaryType: BinaryType = 'blob'; extensions = ''; protocol = ''
  onopen: WebSocket['onopen'] = null; onclose: WebSocket['onclose'] = null
  onerror: WebSocket['onerror'] = null; onmessage: WebSocket['onmessage'] = null
  sent: Record<string, unknown>[] = []
  constructor(public url: string | URL) { super(); Socket.sockets.push(this) }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) { this.sent.push(JSON.parse(String(data))) }
  // A suspended phone can leave the closing handshake stuck, too.
  close() { this.readyState = 2 }
  open() { this.readyState = 1; this.onopen?.call(this as unknown as WebSocket, new Event('open')) }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); Socket.sockets = [] })

test.each(['background', 'bfcache', 'connecting'])('%s recovery replaces a stale data socket immediately and retains requests', async (trigger) => {
  vi.useFakeTimers()
  vi.stubGlobal('window', new EventTarget())
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('document', doc)
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('CloseEvent', class extends Event { code = 1000; reason = ''; wasClean = true })
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://test.convex.cloud')
  const { getConvexClient } = await import('./convexClient')
  const client: ConvexReactClient = getConvexClient()
  const stop = client.watchQuery(anyApi.remote.getRemoteState, { token: 'test' }).onUpdate(() => {})
  if (trigger !== 'connecting') Socket.sockets[0].open()
  void client.mutation(anyApi.remote.sendCommand, { token: 'test', sessionId: 'test', kind: 'write', payload: { data: 'once' } }).catch(() => {})
  const { subscribeForegroundResync } = await import('./foreground-resync')
  const unbind = subscribeForegroundResync(() => client.connectionState().isWebSocketConnected)
  expect(client.connectionState().isWebSocketConnected).toBe(trigger !== 'connecting')
  // The OS drops the network without delivering onclose. Returning must not
  // wait for Convex's 60-second inactivity watchdog or a native close handshake.
  if (trigger === 'bfcache') window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  else {
    doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'))
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'))
  }
  expect(Socket.sockets).toHaveLength(2)
  Socket.sockets[1].open()
  expect(Socket.sockets[1].sent.some(message => message.type === 'ModifyQuerySet')).toBe(true)
  expect(Socket.sockets[1].sent.filter(message => message.type === 'Mutation')).toMatchObject([{ requestId: 0, udfPath: 'remote:sendCommand' }])
  window.dispatchEvent(new Event('focus'))
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  expect(Socket.sockets).toHaveLength(2)
  unbind(); stop()
  const closing = client.close()
  Socket.sockets[1].onclose?.call(Socket.sockets[1] as unknown as WebSocket, new CloseEvent('close'))
  await closing
})
