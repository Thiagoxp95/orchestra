'use client'
import { useEffect } from 'react'
import { useConvex } from 'convex/react'

/**
 * Convex's websocket client only reconnects on the browser `online` event and a
 * 60s server-inactivity watchdog (serverInactivityThreshold = 60_000). On mobile,
 * when the installed PWA is backgrounded and then foregrounded, the socket is
 * dropped (or frozen) but neither trigger fires promptly — so the UI keeps showing
 * stale state (a session that never appears, a worktree that was already deleted)
 * for up to ~60s until the watchdog finally forces a reconnect.
 *
 * The desktop bridge already reconciles its mirror on focus / resume / unlock
 * (see remote-bridge.ts). This gives the web the same guarantee from the other
 * end: when the page returns to the foreground and the socket is not connected,
 * dispatch a synthetic `online` event. Convex's own network listener handles it
 * via `tryReconnectImmediately()`, collapsing the reconnect from "up to ~60s" to
 * "now". We poke the public `online` event rather than Convex internals so this
 * stays robust across convex-client versions.
 */
export function resyncIfDisconnected(
  isConnected: () => boolean,
  dispatchOnline: () => void,
): boolean {
  if (isConnected()) return false
  dispatchOnline()
  return true
}

/**
 * Force an immediate Convex reconnect whenever the page returns to the
 * foreground (tab focus, PWA un-background, bfcache restore) and the socket has
 * gone stale. Mount once, inside the ConvexProvider.
 */
export function useForegroundResync(): void {
  const convex = useConvex()
  useEffect(() => {
    const resync = (): void => {
      resyncIfDisconnected(
        () => convex.connectionState().isWebSocketConnected,
        () => window.dispatchEvent(new Event('online')),
      )
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') resync()
    }
    document.addEventListener('visibilitychange', onVisibility)
    // `focus` covers desktop tab switches; `pageshow` covers a bfcache restore
    // where the page (and its dead socket) is resurrected without a reload.
    window.addEventListener('focus', resync)
    window.addEventListener('pageshow', resync)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', resync)
      window.removeEventListener('pageshow', resync)
    }
  }, [convex])
}
