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

/**
 * Which side of the link is broken.
 *
 * `bridgeLiveness` alone can only say "nothing has arrived lately", and the web
 * has always reported that as "Desktop offline" — which is a guess, and on a
 * phone usually the wrong one. The mirror reaches the phone over a Convex
 * websocket that an installed PWA drops on every background/lock, so a frozen
 * `updatedAt` is at least as often *this device* having lost the socket as the
 * Mac having gone away. Naming the right side is what makes the retry below
 * make sense: a dead socket is fixable from here, a sleeping Mac is not.
 */
export type BridgeTone = 'live' | 'offline' | 'disconnected'

export interface BridgeStatus {
  tone: BridgeTone
  /** The desktop hasn't pushed within the threshold. */
  stale: boolean
  secondsAgo: number | null
  /** Compact age for the badge — "12s", "4m" — or null if it never pushed. */
  lastSeen: string | null
  /** Headline: what is wrong, in three words. */
  title: string
  /** One sentence on what it means and what a retry can do about it. */
  detail: string
}

export function bridgeStatus({
  updatedAt,
  now,
  socketConnected,
  thresholdMs = BRIDGE_STALE_MS,
}: {
  updatedAt: number | null | undefined
  now: number
  /** Convex's own view of its websocket (connectionState().isWebSocketConnected). */
  socketConnected: boolean
  thresholdMs?: number
}): BridgeStatus {
  const { stale, secondsAgo } = bridgeLiveness(updatedAt, now, thresholdMs)
  const lastSeen = secondsAgo != null ? formatSecondsAgo(secondsAgo) : null

  // The socket outranks staleness: with no websocket, `updatedAt` is frozen at
  // whatever arrived before the drop, so it says nothing at all about the Mac.
  if (!socketConnected) {
    return {
      tone: 'disconnected',
      stale,
      secondsAgo,
      lastSeen,
      title: 'This phone is offline',
      detail:
        'The connection to the mirror dropped, so nothing is arriving — the desktop may well be fine. Reconnect retries from here.',
    }
  }

  if (stale) {
    return {
      tone: 'offline',
      stale,
      secondsAgo,
      lastSeen,
      title: 'Desktop offline',
      detail:
        'This phone is connected, but Orchestra has stopped pushing from your computer. Reconnect asks again; if it stays quiet, wake the machine or reopen Orchestra there.',
    }
  }

  return {
    tone: 'live',
    stale,
    secondsAgo,
    lastSeen,
    title: 'Desktop connected',
    detail: 'Orchestra is pushing from your computer. Attaching, spawning and typing all reach it.',
  }
}
