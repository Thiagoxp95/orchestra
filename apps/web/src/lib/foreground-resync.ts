'use client'
import { useEffect, useState } from 'react'
import { useConvex } from 'convex/react'
import { reconnectConvexTransport } from './convexClient'

/** Wake Convex's retry loop after a transport close, without replacing the client. */
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
  useEffect(() => subscribeForegroundResync(() => convex.connectionState().isWebSocketConnected), [convex])
}

// `isWebSocketConnected` can remain true after mobile suspension. Retire that
// socket on every foreground return — an `online` event alone only accelerates
// Convex's disconnected state and cannot repair a half-open socket. iOS PWAs
// often deliver `focus`/`pageshow` without a preceding `visibilitychange`, so
// those handlers force-recover too (reconnectConvexTransport debounces at 1s).
export function subscribeForegroundResync(isConnected: () => boolean): () => void {
  const resync = (force = false): void => {
    if (document.visibilityState !== 'visible') return
    if (force) reconnectConvexTransport()
    resyncIfDisconnected(
      isConnected,
      () => window.dispatchEvent(new Event('online')),
    )
  }
  const onForeground = (): void => resync(true)
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') return
    onForeground()
  }
  const onFocus = () => onForeground()
  const onPageShow = () => onForeground()
  const onOnline = (event: Event) => { if (event.isTrusted) resync(true) }
  document.addEventListener('visibilitychange', onVisibility)
  // `focus` covers desktop tab switches; `pageshow` covers a bfcache restore
  // where the page (and its dead socket) is resurrected without a reload.
  window.addEventListener('focus', onFocus)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('online', onOnline)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('pageshow', onPageShow)
    window.removeEventListener('online', onOnline)
  }
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
    let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null
    const bump = (): void => {
      if (document.visibilityState !== 'visible') return
      const away = hiddenAt != null ? Date.now() - hiddenAt : 0
      // Re-anchor costs a brief seed repaint — skip ordinary tab focus, but do
      // recover after a real background gap. pageshow/focus cover iOS PWAs that
      // resume without visibilitychange.
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
