'use client'
import { useEffect, useState } from 'react'
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

/**
 * A counter that increments each time the page returns to the foreground from a
 * hidden/backgrounded state. Feed it into a component `key` to force a clean
 * remount on foreground. The terminal mirror uses this to re-anchor the chunk
 * stream (fresh attach + seed, afterSeq reset to -1) when the PWA un-backgrounds
 * or the phone unlocks — the automatic equivalent of the manual "close and
 * reopen the PWA" recovery, so a stranded cursor or a half-open socket can never
 * leave the terminal frozen until the user intervenes.
 *
 * Reconnecting the socket alone (useForegroundResync) refreshes the reactive
 * STATE queries but cannot un-freeze the terminal: getChunks is re-run with the
 * same stale afterSeq, so a remount is the only thing that re-seeds.
 */
export function useForegroundNonce(): number {
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    // visibilitychange→visible fires exactly when we return from background (and
    // on unlock), not on every minor focus change — the right granularity for a
    // re-anchor that costs a brief seed repaint.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') setNonce((n) => n + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
  return nonce
}
