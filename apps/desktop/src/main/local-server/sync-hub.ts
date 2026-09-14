// src/main/local-server/sync-hub.ts
//
// Reactive query dispatch. This is what Convex's WebSocket subscriptions used
// to provide: a client subscribes by name, gets the current value, and gets
// pushed a new one whenever the underlying data changes.
//
// The difference is that the data now lives in this process. Nothing is
// written to a database and read back; a query is a plain function over
// desktop state, and `invalidate` re-runs the subscriptions that depend on it.

export type QueryHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>
export type CallHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>

export interface Subscriber {
  /** Deliver one subscription's current value. */
  value: (id: number, value: unknown) => void
  /** Deliver a subscription-level failure. */
  error: (id: number, message: string) => void
}

interface Subscription {
  name: string
  args: Record<string, unknown>
  /** Last value serialized, so an invalidation that changes nothing sends nothing. */
  sent: string | undefined
  /** Guards against overlapping re-evaluations of the same subscription. */
  running: boolean
  /** Set when an invalidation lands mid-flight, so we re-run once instead of queueing. */
  dirty: boolean
}

export class SyncHub {
  private readonly queries = new Map<string, QueryHandler>()
  private readonly calls = new Map<string, CallHandler>()
  private readonly subscribers = new Map<Subscriber, Map<number, Subscription>>()

  query(name: string, handler: QueryHandler): void {
    this.queries.set(name, handler)
  }

  call(name: string, handler: CallHandler): void {
    this.calls.set(name, handler)
  }

  hasQuery(name: string): boolean {
    return this.queries.has(name)
  }

  connect(subscriber: Subscriber): void {
    this.subscribers.set(subscriber, new Map())
  }

  disconnect(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber)
  }

  subscribe(subscriber: Subscriber, id: number, name: string, args: Record<string, unknown>): void {
    const owned = this.subscribers.get(subscriber)
    if (!owned) return
    if (!this.queries.has(name)) {
      subscriber.error(id, `Unknown query: ${name}`)
      return
    }
    const subscription: Subscription = { name, args, sent: undefined, running: false, dirty: false }
    owned.set(id, subscription)
    void this.evaluate(subscriber, id, subscription)
  }

  unsubscribe(subscriber: Subscriber, id: number): void {
    this.subscribers.get(subscriber)?.delete(id)
  }

  /** Run a write. Rejects rather than throwing so the caller can answer the client. */
  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    const handler = this.calls.get(name)
    if (!handler) throw new Error(`Unknown function: ${name}`)
    return handler(args)
  }

  /**
   * Re-run every live subscription on these queries and push the ones whose
   * value actually changed. Safe to call on every state mutation — unchanged
   * values cost a comparison, not a message.
   */
  invalidate(...names: string[]): void {
    const changed = new Set(names)
    for (const [subscriber, owned] of this.subscribers) {
      for (const [id, subscription] of owned) {
        if (changed.has(subscription.name)) void this.evaluate(subscriber, id, subscription)
      }
    }
  }

  private async evaluate(subscriber: Subscriber, id: number, subscription: Subscription): Promise<void> {
    // An async query invalidated while in flight re-runs once when it settles,
    // rather than interleaving two evaluations and racing to send.
    if (subscription.running) {
      subscription.dirty = true
      return
    }
    subscription.running = true
    try {
      do {
        subscription.dirty = false
        const handler = this.queries.get(subscription.name)
        if (!handler) return
        const value = await handler(subscription.args)
        // Dropped while awaiting.
        if (this.subscribers.get(subscriber)?.get(id) !== subscription) return
        const encoded = JSON.stringify(value ?? null)
        if (encoded === subscription.sent) continue
        subscription.sent = encoded
        subscriber.value(id, value ?? null)
      } while (subscription.dirty)
    } catch (err) {
      subscriber.error(id, err instanceof Error ? err.message : String(err))
    } finally {
      subscription.running = false
    }
  }
}
