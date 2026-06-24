/**
 * Keeps exactly one live Convex subscription, re-establishing it on demand and
 * always disposing the previous handle first.
 *
 * The command loop lives entirely on a single `onUpdate(pendingCommands)`
 * subscription. If that subscription silently wedges — the websocket reports
 * connected but stops delivering, which the Convex client's own reconnect won't
 * catch — the desktop stops draining commands: attaching no longer seeds the
 * phone's terminal (black screen) and spawning does nothing, even though the
 * state-push heartbeat (plain mutations, which do reconnect) keeps the sidebar
 * looking healthy. The bridge defends against that by periodically tearing the
 * subscription down and re-creating it; on every re-subscribe Convex immediately
 * fires the current pending list, so commands queued during the gap run at once.
 *
 * Disposing the previous handle before creating the next is the load-bearing
 * part: leak one and every interval stacks another live subscription, so each
 * pending command gets delivered — and applied — N times over.
 */
export interface Resubscriber {
  /** Dispose the current subscription (if any) and create a fresh one. */
  resubscribe(): void
  /** Dispose the current subscription and stop. */
  stop(): void
  /** Whether a subscription is currently live. */
  readonly active: boolean
}

export function createResubscriber(subscribe: () => () => void): Resubscriber {
  let unsubscribe: (() => void) | null = null
  return {
    resubscribe(): void {
      unsubscribe?.()
      unsubscribe = subscribe()
    },
    stop(): void {
      unsubscribe?.()
      unsubscribe = null
    },
    get active(): boolean {
      return unsubscribe !== null
    },
  }
}
