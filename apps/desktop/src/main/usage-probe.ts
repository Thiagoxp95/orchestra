// usage-probe.ts — Thin orchestration over the Claude OAuth usage API and the
// Codex session-log scanner. Both paths rely only on the official artifacts
// that Claude Code and Codex themselves produce.

import { readClaudeOAuthToken } from './claude-oauth-credentials'
import { fetchClaudeUsage, type FetchClaudeUsageResult } from './claude-usage-api'
import { scanRecentCodexRateLimits, type ScanResult } from './codex-usage-probe'
import type { UsageProbeResult } from '../shared/types'

function claudeErrorMessage(
  code: 'not-logged-in' | 'token-expired' | 'rate-limited' | 'request-failed' | 'network-error',
  status?: number,
): string {
  switch (code) {
    case 'not-logged-in': return 'Claude Code not logged in'
    case 'token-expired': return 'Token expired — run claude to refresh'
    case 'rate-limited': return 'Rate-limited — backing off'
    case 'request-failed': return status ? `Usage request failed (${status})` : 'Usage request failed'
    case 'network-error': return 'Network error'
  }
}

export interface ProbeClaudeDeps {
  readToken?: typeof readClaudeOAuthToken
  fetchUsage?: (token: { accessToken: string } | null) => Promise<FetchClaudeUsageResult>
}

export async function probeClaudeUsage(deps: ProbeClaudeDeps = {}): Promise<UsageProbeResult> {
  const readToken = deps.readToken ?? readClaudeOAuthToken
  const fetchUsage = deps.fetchUsage ?? ((t) => fetchClaudeUsage(t))

  const token = await readToken()
  const result = await fetchUsage(token)

  if (!result.ok) {
    // Surface the underlying status/body so we can diagnose intermittent
    // 5xx / rate-limit responses from the OAuth usage endpoint without the
    // user having to run a devtools request themselves.
    console.warn(
      '[usage-probe] Claude usage request failed:',
      { error: result.error, status: result.status, detail: result.detail, retryAfterMs: result.retryAfterMs },
    )
    return {
      provider: 'claude',
      session: null,
      weekly: null,
      error: claudeErrorMessage(result.error, result.status),
      updatedAt: Date.now(),
      cooldownUntil: result.retryAfterMs ? Date.now() + result.retryAfterMs : undefined,
    }
  }

  if (!result.session && !result.weekly) {
    return {
      provider: 'claude',
      session: null,
      weekly: null,
      error: 'No utilization data',
      updatedAt: Date.now(),
    }
  }

  return {
    provider: 'claude',
    session: result.session,
    weekly: result.weekly,
    error: null,
    updatedAt: Date.now(),
  }
}

export interface ProbeCodexDeps {
  scan?: () => Promise<ScanResult>
}

export async function probeCodexUsage(deps: ProbeCodexDeps = {}): Promise<UsageProbeResult> {
  const scanFn = deps.scan ?? (() => scanRecentCodexRateLimits())
  const scan = await scanFn()
  const updatedAt = Date.now()

  switch (scan.kind) {
    case 'no-sessions':
      return { provider: 'codex', session: null, weekly: null, error: 'No Codex sessions found', updatedAt }
    case 'no-recent-rate-limits':
      return { provider: 'codex', session: null, weekly: null, error: 'No recent Codex activity', updatedAt }
    case 'ok':
      return {
        provider: 'codex',
        session: scan.session,
        weekly: scan.weekly,
        error: scan.stale ? 'stale' : null,
        updatedAt,
      }
  }
}
