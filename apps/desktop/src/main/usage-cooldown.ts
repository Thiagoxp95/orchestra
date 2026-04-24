// usage-cooldown.ts — Pure helpers for probe scheduling and rate-limit backoff.
//
// The /api/oauth/usage endpoint is known to 429 aggressively and rarely sends
// a Retry-After header (see anthropics/claude-code#31637, #31021). These
// helpers implement the client-side policy that keeps us from amplifying the
// rate limit: a long base interval with jitter to avoid synchronized bursts
// across instances, and exponential escalation on repeated 429s.

const MIN_MS = 60_000
const BASE_BACKOFF_MS = 30 * MIN_MS
const MAX_BACKOFF_MS = 60 * MIN_MS
const JITTER_RATIO = 0.2 // ±20%

export function computeClaudeCooldown(
  consecutiveFailures: number,
  serverFloorMs: number,
  now: number = Date.now(),
): number {
  const n = Math.max(1, consecutiveFailures)
  const escalated = Math.min(BASE_BACKOFF_MS * Math.pow(2, n - 1), MAX_BACKOFF_MS)
  return Math.max(now + escalated, serverFloorMs)
}

export function nextProbeDelayMs(baseMs: number): number {
  const jitter = baseMs * JITTER_RATIO * (Math.random() * 2 - 1)
  return Math.round(baseMs + jitter)
}
