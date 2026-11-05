/**
 * Decide whether the desktop looks offline, from the sync socket.
 *
 * The phone talks straight to a server inside the desktop app, so a socket that
 * is open and answering pings IS a live desktop. Reading liveness off a
 * timestamp inside the mirrored state made the desktop resend all of it on
 * every heartbeat, and a phone on a slow link fell minutes behind and called a
 * live desktop "offline".
 */

// Reconnecting after the phone wakes takes well under this, so the banner never
// flashes on foreground; a desktop that is really gone shows within seconds.
export const OFFLINE_GRACE_MS = 5_000

export interface SyncConnection {
  /** When the socket stopped being usable, or null while connected. */
  offlineSince: number | null
  /** When the desktop last sent anything, or 0 if it never has. */
  lastSeenAt: number
}

export interface BridgeLiveness {
  /** Disconnected for longer than the grace: tell the user. */
  stale: boolean
  /** Whole seconds since the desktop last sent anything, or null if it never has. */
  secondsAgo: number | null
}

export function bridgeLiveness(
  connection: SyncConnection,
  now: number,
  graceMs: number = OFFLINE_GRACE_MS,
): BridgeLiveness {
  if (connection.offlineSince == null) return { stale: false, secondsAgo: null }
  return {
    stale: now - connection.offlineSince > graceMs,
    secondsAgo: connection.lastSeenAt > 0 ? Math.floor(Math.max(0, now - connection.lastSeenAt) / 1000) : null,
  }
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
