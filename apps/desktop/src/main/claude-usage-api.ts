// claude-usage-api.ts — Call Anthropic's OAuth usage endpoint directly.
//
// This replaces the ccline dependency. The endpoint and auth scheme are the
// same ones Claude Code itself uses for its /usage slash command.

import type { RateWindow } from '../shared/types'

export interface ClaudeUsagePayload {
  session: RateWindow | null
  weekly: RateWindow | null
}

export type FetchClaudeUsageResult =
  | ({ ok: true } & ClaudeUsagePayload)
  | { ok: false; error: 'not-logged-in' | 'token-expired' | 'request-failed' | 'network-error' }

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const BETA_HEADER = 'oauth-2025-04-20'
const REQUEST_TIMEOUT_MS = 8_000

function normalizePercent(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  // Accept either 0-1 fractions or 0-100 percentages.
  const pct = raw <= 1 && raw >= 0 ? raw * 100 : raw
  return Math.max(0, Math.min(100, pct))
}

function extractWindow(obj: unknown): RateWindow | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const pct = normalizePercent(o.utilization)
  if (pct === null) return null
  const resetsAt = typeof o.resets_at === 'string' ? o.resets_at : null
  return { usedPercent: pct, resetsAt }
}

export function parseClaudeUsageResponse(body: unknown): ClaudeUsagePayload {
  if (!body || typeof body !== 'object') {
    return { session: null, weekly: null }
  }
  const b = body as Record<string, unknown>

  // Nested shape: { five_hour: {utilization, resets_at}, seven_day: {...} }
  const nestedSession = extractWindow(b.five_hour)
  const nestedWeekly = extractWindow(b.seven_day)
  if (nestedSession || nestedWeekly) {
    return { session: nestedSession, weekly: nestedWeekly }
  }

  // Flat shape (ccline-style): { five_hour_utilization, seven_day_utilization, resets_at }
  const sessionPct = normalizePercent(b.five_hour_utilization)
  const weeklyPct = normalizePercent(b.seven_day_utilization)
  const resetsAt = typeof b.resets_at === 'string' ? b.resets_at : null

  return {
    // Flat shape carries only a single resets_at, which maps to the weekly window.
    session: sessionPct !== null ? { usedPercent: sessionPct, resetsAt: null } : null,
    weekly: weeklyPct !== null ? { usedPercent: weeklyPct, resetsAt } : null,
  }
}

export interface FetchClaudeUsageOptions {
  fetchFn?: typeof fetch
  timeoutMs?: number
}

export async function fetchClaudeUsage(
  token: { accessToken: string } | null,
  opts: FetchClaudeUsageOptions = {},
): Promise<FetchClaudeUsageResult> {
  if (!token?.accessToken) {
    return { ok: false, error: 'not-logged-in' }
  }

  const fetchFn = opts.fetchFn ?? fetch
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetchFn(USAGE_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        'anthropic-beta': BETA_HEADER,
        accept: 'application/json',
      },
      signal: controller.signal,
    })

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'token-expired' }
    }
    if (!res.ok) {
      return { ok: false, error: 'request-failed' }
    }

    let body: unknown
    try {
      body = await res.json()
    } catch {
      return { ok: false, error: 'request-failed' }
    }

    const parsed = parseClaudeUsageResponse(body)
    return { ok: true, ...parsed }
  } catch {
    return { ok: false, error: 'network-error' }
  } finally {
    clearTimeout(timer)
  }
}
