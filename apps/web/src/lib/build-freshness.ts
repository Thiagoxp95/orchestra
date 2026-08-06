'use client'
import { useEffect } from 'react'

/**
 * A phone PWA keeps its page alive for days. useForegroundResync reconnects the
 * DATA socket on foreground, but nothing ever re-fetched the CODE — so a fix
 * deployed to prod never reached a long-lived client (the model-picker "still
 * broken" rounds were a week-old bundle executing on the phone long after the
 * fix shipped). This is the missing half: on every return to the foreground,
 * ask the server which build is live; if it differs from the build this page
 * was compiled from, reload. A reload here is exactly the event the app already
 * survives — iOS reclaiming a backgrounded tab — and the composer draft is
 * parked in localStorage on every keystroke (see composer-draft.ts).
 */

/** Reloads are throttled so a half-rolled deploy can never loop the page. */
export const RELOAD_THROTTLE_MS = 5 * 60_000
/** visibility/pageshow can fire in bursts; one server probe a minute is plenty. */
export const CHECK_THROTTLE_MS = 60_000

const RELOAD_STAMP_KEY = 'orchestra.buildReloadAt'

/** Build ids come from Date.now().toString(36) (next.config.ts); anything else
 *  (an HTML error page, a proxy interstitial) must never trigger a reload. */
export function isValidBuildId(id: string): boolean {
  return /^[0-9a-z]{1,32}$/.test(id)
}

/**
 * Pure decision: reload only when both ids are trustworthy, they differ, and we
 * haven't already reloaded for a build change inside the throttle window (a
 * sessionStorage stamp — survives the reload it guards against).
 */
export function shouldReload(
  runningId: string | undefined,
  serverId: string,
  lastReloadAt: number | null,
  now: number,
): boolean {
  if (!runningId || !isValidBuildId(runningId)) return false
  if (!isValidBuildId(serverId)) return false
  if (serverId === runningId) return false
  if (lastReloadAt !== null && now - lastReloadAt < RELOAD_THROTTLE_MS) return false
  return true
}

type FreshnessDeps = {
  runningId: string | undefined
  fetchServerId: () => Promise<string>
  getLastReloadAt: () => number | null
  setLastReloadAt: (at: number) => void
  reload: () => void
  now: () => number
}

/** One probe: fetch the live build id and reload if this page predates it.
 *  Returns whether a reload was issued. Network errors mean "not stale". */
export async function checkBuildFreshness(deps: FreshnessDeps): Promise<boolean> {
  let serverId: string
  try {
    serverId = (await deps.fetchServerId()).trim()
  } catch {
    return false
  }
  if (!shouldReload(deps.runningId, serverId, deps.getLastReloadAt(), deps.now())) return false
  deps.setLastReloadAt(deps.now())
  deps.reload()
  return true
}

function storedReloadAt(): number | null {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_STAMP_KEY)
    if (!raw) return null
    const at = Number(raw)
    return Number.isFinite(at) ? at : null
  } catch {
    // Private mode: fall back to "never reloaded". The worst case is one extra
    // reload per foreground during a deploy race, still bounded by CHECK_THROTTLE_MS.
    return null
  }
}

/**
 * Reload the page when the server is running a newer build. Mount once, next to
 * useForegroundResync — same trigger points (foreground return, bfcache restore),
 * because those are exactly the moments a page can be arbitrarily old.
 */
export function useBuildFreshness(): void {
  useEffect(() => {
    let lastCheckAt = 0
    const check = (): void => {
      const now = Date.now()
      if (now - lastCheckAt < CHECK_THROTTLE_MS) return
      lastCheckAt = now
      void checkBuildFreshness({
        runningId: process.env.NEXT_PUBLIC_BUILD_ID,
        fetchServerId: async () => {
          const res = await fetch('/api/build-id', { cache: 'no-store' })
          if (!res.ok) throw new Error(`build-id ${res.status}`)
          return res.text()
        },
        getLastReloadAt: storedReloadAt,
        setLastReloadAt: (at) => {
          try {
            window.sessionStorage.setItem(RELOAD_STAMP_KEY, String(at))
          } catch {
            // Private mode — see storedReloadAt.
          }
        },
        reload: () => window.location.reload(),
        now: () => Date.now(),
      })
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') check()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', check)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', check)
    }
  }, [])
}
