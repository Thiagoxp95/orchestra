// Pure decisions behind the usage badge, split out of usage-manager.ts for the
// same reason agent-message-model.ts is split from remote-bridge-messages.ts:
// the manager owns ipc handlers, a BrowserWindow and the electron-store, so
// importing it drags the whole main-process graph in. These functions touch
// nothing but their arguments, so they can be tested directly.

import type { UsageProbeResult } from '../shared/types'

// Claude's base cadence when the endpoint is healthy. Gentle by design: this
// is the network path, and it's the only 429 source.
export const CLAUDE_BACKOFF_START_MS = 60_000
// Backoff ceiling after repeated 429s / errors.
export const CLAUDE_BACKOFF_MAX_MS = 10 * 60_000

// When a probe fails (rate-limit, network error, token blip) the API returns
// `{ session: null, weekly: null, error }`. Replacing the snapshot with that
// wipes the last good numbers and the footer badge — which only renders
// providers with at least one usable window — drops the entry entirely until
// the user hovers and triggers another probe. Preserve the previous data and
// surface the new error instead so the badge keeps showing what we know.
export function mergeProbeResult(
  previous: UsageProbeResult | null,
  next: UsageProbeResult,
): UsageProbeResult {
  const nextHasData = next.session !== null || next.weekly !== null
  const previousHasData = !!previous && (previous.session !== null || previous.weekly !== null)
  if (nextHasData || !previousHasData) return next
  return {
    ...previous!,
    error: next.error,
    updatedAt: previous!.updatedAt,
  }
}

// Compute the next Claude backoff delay from the probe that just completed.
// A clean probe (no error) resets to 0 → next poll fires at the base cadence.
// A rate-limit / error doubles the extra delay (capped) so repeated 429s space
// the polls out instead of hammering the endpoint.
export function nextClaudeBackoffMs(
  currentBackoffMs: number,
  probe: UsageProbeResult | null,
): number {
  if (!probe?.error) return 0
  if (currentBackoffMs <= 0) return CLAUDE_BACKOFF_START_MS
  return Math.min(currentBackoffMs * 2, CLAUDE_BACKOFF_MAX_MS)
}
