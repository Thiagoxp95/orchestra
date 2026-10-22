// lib/sync/react.tsx
//
// React bindings over the sync client: a provider plus the two hooks the app
// reads and writes through. Deliberately the same shape the Convex hooks had,
// so component code says what it means rather than managing a socket.

'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { getSyncClient, type SyncClient } from './client'
import type { FunctionName } from './api'

const SyncContext = createContext<SyncClient | null>(null)

export function SyncProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => getSyncClient(), [])
  return <SyncContext.Provider value={client}>{children}</SyncContext.Provider>
}

export function useSync(): SyncClient {
  const client = useContext(SyncContext)
  if (!client) throw new Error('useSync must be used inside <SyncProvider>')
  return client
}

/** Pass instead of args to hold a query back until its inputs are known. */
export const SKIP = 'skip' as const

export type QueryArgs = Record<string, unknown> | typeof SKIP

const NO_OP = () => {}
const NO_VALUE = () => undefined

/**
 * Subscribe to a query for as long as the component is mounted.
 *
 * Returns `undefined` until the first value arrives, which is how callers tell
 * "still loading" from a genuine `null`. Passing SKIP holds the query back
 * without changing the number of hooks the component runs.
 */
export function useQuery<T = unknown>(name: FunctionName, args: QueryArgs = {}): T | undefined {
  const client = useSync()
  // Re-subscribe on a real argument change, not on every new object literal.
  const key = args === SKIP ? null : JSON.stringify(args)

  const subscribe = useCallback(
    (onChange: () => void) => (key === null ? NO_OP : client.subscribe(name, key, onChange)),
    [client, name, key],
  )
  // The client caches each value by reference, so React can tell an unchanged
  // snapshot from a new one without a deep compare.
  const snapshot = useCallback(
    () => (key === null ? undefined : client.peek(name, key)),
    [client, name, key],
  )

  // The static export renders this on the server, where there is no socket;
  // NO_VALUE keeps that pass identical to the first client render.
  return useSyncExternalStore(subscribe, snapshot, NO_VALUE) as T | undefined
}

/** A stable callback that runs a write. */
export function useMutation<A extends Record<string, unknown> = Record<string, unknown>, R = unknown>(
  name: FunctionName,
): (args?: A) => Promise<R> {
  const client = useSync()
  return useCallback((args?: A) => client.call(name, args ?? {}) as Promise<R>, [client, name])
}

/** Whether the desktop is currently reachable. Drives the connection banner. */
export function useSyncConnected(): boolean {
  const client = useSync()
  const subscribe = useCallback(
    (onChange: () => void) => client.onStatusChange(onChange),
    [client],
  )
  const snapshot = useCallback(() => client.isConnected(), [client])
  // Optimistic on the server: the banner should appear after a failure, not
  // flash on every load.
  return useSyncExternalStore(subscribe, snapshot, () => true)
}

/**
 * Re-check the socket whenever the page returns to the foreground.
 *
 * A phone's socket routinely survives screen-lock in name only: `readyState`
 * still reads OPEN while nothing can traverse it. Foreground events are the
 * one reliable moment to notice, so after a real absence the socket is
 * replaced outright (SyncClient.resync); a brief focus change only probes it,
 * which keeps a healthy socket's in-flight calls alive. iOS PWAs often deliver
 * `focus`/`pageshow` with no preceding `visibilitychange`, so all three are
 * handled — and the client also distrusts a socket that has been silent past a
 * heartbeat, which catches a wake no event announced.
 */
export function useForegroundResync(): void {
  const client = useSync()
  const last = useRef(0)
  useEffect(() => {
    // When the page last went to the background; null while it hasn't since
    // the previous resync. iOS may skip `visibilitychange` entirely, and blur
    // marks that case too.
    let hiddenAt: number | null = null
    const markHidden = (): void => {
      if (hiddenAt === null) hiddenAt = Date.now()
    }
    const resync = (force = false): void => {
      if (document.visibilityState !== 'visible') return
      // Debounced: the events below often fire together for one wake.
      if (!force && Date.now() - last.current < 1000) return
      last.current = Date.now()
      const hiddenFor = force ? Infinity : hiddenAt === null ? 0 : Date.now() - hiddenAt
      hiddenAt = null
      client.resync(hiddenFor)
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') resync()
      else markHidden()
    }
    const onForeground = (): void => resync()
    // A network change (Wi-Fi ⇄ cellular, tailnet back) strands the old socket.
    const onOnline = (): void => resync(true)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onForeground)
    window.addEventListener('pageshow', onForeground)
    window.addEventListener('blur', markHidden)
    window.addEventListener('pagehide', markHidden)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onForeground)
      window.removeEventListener('pageshow', onForeground)
      window.removeEventListener('blur', markHidden)
      window.removeEventListener('pagehide', markHidden)
      window.removeEventListener('online', onOnline)
    }
  }, [client])
}

/**
 * A counter that increments each time the page returns to the foreground after
 * a real absence. Feed it into a `key` to force a clean remount — the terminal
 * uses it to re-attach and re-seed, since reconnecting the socket refreshes
 * state queries but cannot by itself un-freeze a stranded stream.
 */
export function useForegroundNonce(): number {
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null
    const bump = (): void => {
      if (document.visibilityState !== 'visible') return
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt
      // Re-anchoring costs a brief seed repaint, so skip ordinary tab focus and
      // only recover after a genuine background gap.
      if (away >= 1000) setNonce((n) => n + 1)
      hiddenAt = null
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now()
      else bump()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', bump)
    window.addEventListener('pageshow', bump)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', bump)
      window.removeEventListener('pageshow', bump)
    }
  }, [])
  return nonce
}
