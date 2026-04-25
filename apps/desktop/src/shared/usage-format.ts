// usage-format.ts — Shared helpers for formatting usage probe output.
//
// Mirrors ClaudeBar's `formatResetText` (Sources/Infrastructure/Claude/
// ClaudeAPIUsageProbe.swift) so reset strings are produced once at probe time
// instead of recomputed on every render. Extended beyond ClaudeBar to also
// describe past-reset windows ("Reset Xh ago") because Codex's rate_limits
// events become stale once a 5h window lapses without new activity, and the
// UI line should still tell the user what state the window is in.

function formatDuration(totalMin: number): string {
  if (totalMin < 60) return `${Math.max(1, totalMin)}m`
  const hours = Math.floor(totalMin / 60)
  const remMin = totalMin % 60
  if (hours < 24) return `${hours}h ${remMin}m`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return `${days}d ${remHours}h`
}

export function formatResetText(resetsAt: string | null, now: number = Date.now()): string | null {
  if (!resetsAt) return null
  const reset = Date.parse(resetsAt)
  if (!Number.isFinite(reset)) return null

  const diffMs = reset - now
  if (diffMs > 0) {
    return `Resets in ${formatDuration(Math.floor(diffMs / 60_000))}`
  }
  // Past: window already lapsed (common for Codex session data when no new
  // turns have happened). Surface this so the UI line isn't blank.
  return `Reset ${formatDuration(Math.floor(-diffMs / 60_000))} ago`
}
