/**
 * Decide whether the desktop bridge looks offline, from how long ago it last
 * pushed state.
 *
 * The bridge heartbeats every 10s (HEARTBEAT_MS in remote-bridge.ts), bumping
 * remoteState.updatedAt on each push. The web is a read-only mirror: it shows the
 * last snapshot Convex retained, and that row is only ever patched — never
 * cleared. So a populated sidebar and a black terminal look identical whether the
 * desktop is live or died an hour ago, leaving nothing to tell the user why
 * attaching and spawning silently do nothing. Comparing updatedAt to the wall
 * clock is the one signal that distinguishes "desktop is live" from "desktop is
 * gone", so the UI can say so instead of showing a silent black screen.
 */

// Three missed heartbeats. Wide enough that a single dropped push or a brief
// network hiccup never flips the banner, tight enough that a genuinely-gone
// desktop is surfaced within a few seconds.
export const BRIDGE_STALE_MS = 30_000

export interface BridgeLiveness {
  /** The desktop hasn't pushed within the threshold — treat it as offline. */
  stale: boolean
  /** Whole seconds since the last desktop push, or null if it never pushed. */
  secondsAgo: number | null
}

export function bridgeLiveness(
  updatedAt: number | null | undefined,
  now: number,
  thresholdMs: number = BRIDGE_STALE_MS,
): BridgeLiveness {
  // No push ever recorded → nothing to compare against. The caller renders the
  // sign-in / empty states in that case, so never claim "stale" here.
  if (updatedAt == null) return { stale: false, secondsAgo: null }
  const elapsed = Math.max(0, now - updatedAt)
  return { stale: elapsed > thresholdMs, secondsAgo: Math.floor(elapsed / 1000) }
}

/**
 * Compact "time since" for the offline banner: seconds under a minute, then
 * minutes, then hours. Coarse on purpose — the exact age past a minute doesn't
 * matter, only that the desktop has been gone a while.
 */
export function formatSecondsAgo(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h`
}
