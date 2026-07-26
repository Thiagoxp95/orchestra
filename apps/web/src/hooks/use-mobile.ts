import * as React from "react"

const MOBILE_BREAKPOINT = 768
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

/**
 * Backstop poll interval. Every event this hook subscribes to is one iOS is known
 * to withhold, coalesce, or deliver late to an installed PWA, and a single missed
 * notification here costs the drawer for the rest of the session. A slow tick can't
 * miss: useSyncExternalStore compares snapshots with Object.is, so a tick that
 * reads the same boolean re-renders nothing at all.
 */
const MOBILE_POLL_MS = 1000

let cachedQuery: MediaQueryList | null = null
const mobileQuery = (): MediaQueryList => (cachedQuery ??= window.matchMedia(MOBILE_QUERY))

/** The snapshot: the media query's own answer, never a width that may lag it. */
export function readIsMobile(): boolean {
  return mobileQuery().matches
}

/** Exported for the regression test; use {@link useIsMobile}. */
export function subscribeIsMobile(onStoreChange: () => void): () => void {
  const mql = mobileQuery()
  mql.addEventListener("change", onStoreChange)
  // `change` alone is not enough on a phone: it fires only when the query result
  // flips (a rotation, essentially), iOS coalesces events for a hidden PWA, and a
  // phone rotated while the app is backgrounded delivers nothing until it comes
  // back — so re-check on every viewport event and on every foreground too.
  window.addEventListener("resize", onStoreChange)
  window.addEventListener("orientationchange", onStoreChange)
  document.addEventListener("visibilitychange", onStoreChange)
  // …and a slow poll under all of it, because every listener above is one iOS may
  // simply not fire, and the cost of a stale value here is the drawer refusing to
  // open until the app is killed. See MOBILE_POLL_MS.
  const poll = setInterval(onStoreChange, MOBILE_POLL_MS)
  return () => {
    mql.removeEventListener("change", onStoreChange)
    window.removeEventListener("resize", onStoreChange)
    window.removeEventListener("orientationchange", onStoreChange)
    document.removeEventListener("visibilitychange", onStoreChange)
    clearInterval(poll)
  }
}

/**
 * Whether the viewport is phone-sized.
 *
 * Not a cosmetic flag: every path that opens the mobile drawer runs through it — the
 * header trigger (toggleSidebar picks openMobile vs the desktop `open`), the
 * two-finger rightward swipe (SessionRoll), and the branch of <Sidebar> that renders
 * the Sheet at all. It lives in SidebarProvider, which nothing ever remounts (the
 * foreground resync keys AppSidebar, a *child* of the provider). So a wrong value
 * here is terminal rather than ugly: the trigger and the swipe both flip desktop
 * state instead, the desktop sidebar they flip is `hidden md:block` and so invisible
 * under 768px, and the drawer stops opening for the rest of the session — recoverable
 * only by killing the PWA.
 *
 * Which is exactly what the shadcn original did. It read `window.innerWidth` inside
 * the matchMedia `change` handler, and that handler runs *only* when the query result
 * flips: one stale read (iOS reports the pre-rotation width while the media query has
 * already flipped) sticks forever, because no second event is coming to correct it.
 *
 * useSyncExternalStore reads `mql.matches` — the value the event is actually about,
 * never a lagging one — and re-reads it on every render of the consumer, so even a
 * dropped event heals on the next state tick instead of at the next launch. The
 * server snapshot stays `false` (desktop-first, corrected on hydration) to keep the
 * SSR and first client render identical.
 */
export function useIsMobile(): boolean {
  return React.useSyncExternalStore(subscribeIsMobile, readIsMobile, () => false)
}
