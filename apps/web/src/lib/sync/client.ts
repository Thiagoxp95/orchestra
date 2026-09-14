// lib/sync/client.ts
//
// The transport to the desktop app. One WebSocket carries every live read and
// every write, and it reconnects on its own — which it must, because a phone's
// socket dies every time the screen locks.
//
// Subscriptions are owned by the client, not the socket: on reconnect they are
// all re-sent and their current values arrive again. That is what lets the UI
// survive a network change without any component knowing it happened.

import {
  SYNC_PATH,
  isSyncServerMessage,
  type SyncClientMessage,
  type SyncServerMessage,
} from './protocol'

/** The desktop serves this app, so its server is always this same origin. */
function syncUrl(): string | null {
  if (typeof window === 'undefined') return null
  const { protocol, host } = window.location
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}${SYNC_PATH}`
}

export type Unsubscribe = () => void

interface Subscription {
  id: number
  name: string
  args: Record<string, unknown>
  /** Notified on every new value; each listener re-reads through `peek`. */
  listeners: Set<() => void>
  errorListeners: Set<(message: string) => void>
  /** Last value seen. Handed to late subscribers so they needn't wait, and
   *  kept by reference so React can compare snapshots cheaply. */
  value: unknown
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** Reconnect backoff. Starts fast — most disconnects are a brief phone sleep. */
const RETRY_MS = [250, 500, 1000, 2000, 5000, 10_000]
const HEARTBEAT_MS = 25_000

export class SyncClient {
  private socket: WebSocket | null = null
  private connected = false
  private nextId = 1
  /** Keyed by `name` + serialized args, so identical watches share one. */
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly byId = new Map<number, Subscription>()
  private readonly pending = new Map<number, PendingCall>()
  /** Calls made while offline, sent once the socket opens. */
  private queue: SyncClientMessage[] = []
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private closed = false
  private readonly statusListeners = new Set<(connected: boolean) => void>()

  constructor(private readonly url: string | null = syncUrl()) {
    this.open()
  }

  // ── Connection ─────────────────────────────────────────────────────────

  private open(): void {
    // No url means no `window`: the app is a static export, so every component
    // is also rendered once at build time. That pass wants a client it can hold
    // and read `undefined` out of, not a socket.
    if (this.closed || this.socket || this.url === null) return
    let socket: WebSocket
    try {
      socket = new WebSocket(this.url)
    } catch {
      this.scheduleRetry()
      return
    }
    this.socket = socket

    socket.onopen = () => {
      if (this.socket !== socket) return
      this.attempt = 0
      this.connected = true
      // Re-establish every live subscription. The server answers each with its
      // current value, so a component that was showing stale data repaints.
      for (const sub of this.subscriptions.values()) {
        this.write({ t: 'sub', id: sub.id, name: sub.name, args: sub.args })
      }
      const queued = this.queue
      this.queue = []
      for (const message of queued) this.write(message)
      this.startHeartbeat()
      this.emitStatus()
    }

    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      let message: unknown
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (isSyncServerMessage(message)) this.receive(message)
    }

    socket.onerror = () => {}
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.teardown()
      this.scheduleRetry()
    }
  }

  private teardown(): void {
    this.socket = null
    this.connected = false
    this.stopHeartbeat()
    // In-flight writes cannot be retried safely: the server may have applied
    // them already. Fail them so the caller can surface it.
    const inFlight = [...this.pending.values()]
    this.pending.clear()
    for (const call of inFlight) call.reject(new Error('Connection to the desktop was lost'))
    this.emitStatus()
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)]
    this.attempt++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    // A phone's socket can appear open long after the network is gone. A
    // periodic ping is what actually surfaces that, letting onclose fire.
    this.heartbeatTimer = setInterval(() => this.write({ t: 'ping' }), HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private write(message: SyncClientMessage): void {
    if (this.socket && this.connected) {
      this.socket.send(JSON.stringify(message))
      return
    }
    // Subscriptions are replayed from `subscriptions` on open; only queue writes.
    if (message.t === 'call') this.queue.push(message)
  }

  private receive(message: SyncServerMessage): void {
    switch (message.t) {
      case 'value': {
        const sub = this.byId.get(message.id)
        if (!sub) return
        sub.value = message.value
        for (const listener of sub.listeners) listener()
        return
      }
      case 'ack': {
        const call = this.pending.get(message.id)
        if (!call) return
        this.pending.delete(message.id)
        call.resolve(message.value)
        return
      }
      case 'err': {
        const call = this.pending.get(message.id)
        if (call) {
          this.pending.delete(message.id)
          call.reject(new Error(message.message))
          return
        }
        const sub = this.byId.get(message.id)
        if (sub) for (const listener of sub.errorListeners) listener(message.message)
        return
      }
      default:
        return
    }
  }

  // ── Public surface ─────────────────────────────────────────────────────

  /** True while the socket is usable. Drives the "reconnecting" banner. */
  isConnected(): boolean {
    return this.connected
  }

  onStatusChange(listener: (connected: boolean) => void): Unsubscribe {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private emitStatus(): void {
    for (const listener of this.statusListeners) listener(this.connected)
  }

  /**
   * Throw away the current socket and dial again immediately.
   *
   * Called when the page returns to the foreground: `readyState` can still say
   * OPEN on a socket that died while the phone was asleep, and only replacing
   * it recovers. Cheap enough to do on every foreground.
   */
  reconnect(): void {
    if (this.closed) return
    const socket = this.socket
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      try {
        socket.close()
      } catch {
        // Already closing.
      }
    }
    this.teardown()
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.attempt = 0
    this.open()
  }

  /**
   * Watch a query for as long as the returned function is uncalled.
   *
   * `onChange` takes no value: React reads through `peek` so it can compare
   * snapshots by reference. `argsKey` is the caller's already-serialized args,
   * which is also how identical watches are recognised and share one
   * subscription on the wire.
   */
  subscribe(
    name: string,
    argsKey: string,
    onChange: () => void,
    onError?: (message: string) => void,
  ): Unsubscribe {
    const key = `${name}|${argsKey}`
    let sub = this.subscriptions.get(key)
    if (!sub) {
      const args = JSON.parse(argsKey) as Record<string, unknown>
      sub = {
        id: this.nextId++,
        name,
        args,
        listeners: new Set(),
        errorListeners: new Set(),
        value: undefined,
      }
      this.subscriptions.set(key, sub)
      this.byId.set(sub.id, sub)
      this.write({ t: 'sub', id: sub.id, name, args })
    }
    const entry = sub
    entry.listeners.add(onChange)
    if (onError) entry.errorListeners.add(onError)
    return () => {
      entry.listeners.delete(onChange)
      if (onError) entry.errorListeners.delete(onError)
      if (entry.listeners.size > 0) return
      this.subscriptions.delete(key)
      this.byId.delete(entry.id)
      this.write({ t: 'unsub', id: entry.id })
    }
  }

  /** The latest value for a watch, or undefined before the first arrives. */
  peek(name: string, argsKey: string): unknown {
    return this.subscriptions.get(`${name}|${argsKey}`)?.value
  }

  /** Read a query once. */
  async query(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const argsKey = JSON.stringify(args)
    return new Promise((resolve, reject) => {
      const stop = this.subscribe(
        name,
        argsKey,
        () => {
          const value = this.peek(name, argsKey)
          stop()
          resolve(value)
        },
        (message) => {
          stop()
          reject(new Error(message))
        },
      )
    })
  }

  /** Run a write and wait for its result. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ t: 'call', id, name, args })
    })
  }

  close(): void {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.stopHeartbeat()
    this.socket?.close()
    this.socket = null
    this.connected = false
  }
}

let shared: SyncClient | null = null

/** The app's single client. Created lazily so it never runs during SSR. */
export function getSyncClient(): SyncClient {
  shared ??= new SyncClient()
  return shared
}
