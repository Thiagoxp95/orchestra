import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncClient } from './client'

/** Minimal stand-in for the browser WebSocket: records sends, opened by hand. */
class FakeSocket {
  static instances: FakeSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: unknown[] = []
  closed = false
  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.onopen?.()
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

const pings = (socket: FakeSocket) => socket.sent.filter((m) => (m as { t: string }).t === 'ping').length

describe('SyncClient liveness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function connected(): { client: SyncClient; socket: FakeSocket } {
    const client = new SyncClient('ws://desktop/sync')
    const socket = FakeSocket.instances[0]
    socket.open()
    return { client, socket }
  }

  it('replaces a socket whose ping goes unanswered', () => {
    const { client, socket } = connected()
    vi.advanceTimersByTime(15_000)
    expect(pings(socket)).toBe(1)

    vi.advanceTimersByTime(4_000)
    expect(socket.closed).toBe(true)
    expect(FakeSocket.instances).toHaveLength(2)
    client.close()
  })

  it('keeps a socket that answers', () => {
    const { client, socket } = connected()
    vi.advanceTimersByTime(15_000)
    socket.receive({ t: 'pong' })
    vi.advanceTimersByTime(4_000)
    expect(socket.closed).toBe(false)
    expect(FakeSocket.instances).toHaveLength(1)
    client.close()
  })

  it('only probes on a brief focus change, keeping in-flight calls', async () => {
    const { client, socket } = connected()
    const call = client.call('remote.write', {})
    client.resync(0)
    expect(socket.closed).toBe(false)
    expect(pings(socket)).toBe(1)

    socket.receive({ t: 'ack', id: (socket.sent[0] as { id: number }).id, value: 'ok' })
    await expect(call).resolves.toBe('ok')
    client.close()
  })

  it('reconnects outright after a long absence', () => {
    const { client, socket } = connected()
    client.resync(60_000)
    expect(socket.closed).toBe(true)
    expect(FakeSocket.instances).toHaveLength(2)
    client.close()
  })

  // A suspended phone may wake with no hide event; its frozen timers left the
  // socket silent far past a heartbeat, which is evidence enough.
  it('reconnects outright when the socket has been silent past a heartbeat', () => {
    const { client, socket } = connected()
    vi.setSystemTime(Date.now() + 60_000)
    client.resync(0)
    expect(socket.closed).toBe(true)
    client.close()
  })
})
