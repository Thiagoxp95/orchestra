import type { TerminalLaunchProfile } from '../shared/types'

export const DEFAULT_WARM_SHELL_POOL_SIZE = 2
export const MAX_WARM_SHELL_POOL_SIZE = 10
export const WARM_SHELL_BURST_WINDOW_MS = 15_000
export const WARM_SHELL_IDLE_TTL_MS = 5 * 60_000

export interface WarmShellCandidate {
  isAttachable: boolean
  isReadyForReuse: boolean
  dispose: () => void
}

export function shouldReuseWarmShell(launchProfile?: TerminalLaunchProfile): boolean {
  return launchProfile?.kind !== 'exec'
}

export function pruneWarmShellPool<T extends WarmShellCandidate>(sessions: T[]): T[] {
  const active: T[] = []

  for (const session of sessions) {
    if (session.isAttachable) {
      active.push(session)
      continue
    }

    session.dispose()
  }

  return active
}

export function countWarmShellCapacity<T extends WarmShellCandidate>(sessions: T[]): number {
  return sessions.filter((session) => session.isAttachable).length
}

export function trimBurstClaimTimestamps(claimedAt: number[], now = Date.now()): number[] {
  return claimedAt.filter((timestamp) => now - timestamp < WARM_SHELL_BURST_WINDOW_MS)
}

export function getAdaptiveWarmShellPoolSize(claimedAt: number[], now = Date.now()): number {
  const recentClaims = trimBurstClaimTimestamps(claimedAt, now)
  return Math.min(MAX_WARM_SHELL_POOL_SIZE, DEFAULT_WARM_SHELL_POOL_SIZE + recentClaims.length)
}

export function pickWarmShellForClaim<T extends WarmShellCandidate>(sessions: T[]): number {
  const readyIndex = sessions.findIndex((session) => session.isAttachable && session.isReadyForReuse)
  if (readyIndex >= 0) return readyIndex
  return sessions.findIndex((session) => session.isAttachable)
}
