// claude-usage-api.ts — Call Anthropic's OAuth usage endpoint directly.
//
// This replaces the ccline dependency. The endpoint and auth scheme are the
// same ones Claude Code itself uses for its /usage slash command.

import type { RateWindow, ScopedRateWindow } from '../shared/types'
import { formatResetText } from '../shared/usage-format'

export interface ClaudeUsagePayload {
  session: RateWindow | null
  weekly: RateWindow | null
  scoped: ScopedRateWindow[]
}

export type FetchClaudeUsageResult =
  | ({ ok: true } & ClaudeUsagePayload)
  | {
      ok: false
      error: 'not-logged-in' | 'token-expired' | 'rate-limited' | 'request-failed' | 'network-error'
      status?: number
      detail?: string
    }

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
  return { usedPercent: pct, resetsAt, resetText: formatResetText(resetsAt) }
}

// --- `limits[]` shape -------------------------------------------------------
//
// The current endpoint returns a generic array alongside the legacy top-level
// windows:
//
//   limits: [
//     { kind: 'session',       group: 'session', percent: 1,   resets_at, scope: null },
//     { kind: 'weekly_all',    group: 'weekly',  percent: 72,  resets_at, scope: null },
//     { kind: 'weekly_scoped', group: 'weekly',  percent: 100, resets_at,
//       scope: { model: { display_name: 'Fable' }, surface: null },
//       severity: 'critical', is_active: true },
//   ]
//
// This array is the only place per-model caps appear — the legacy
// `seven_day_opus` / `seven_day_sonnet` keys are null even when a scoped limit
// is maxed out. We read scopes generically so a newly-introduced model shows
// up without a code change.

const SEVERITIES = new Set(['normal', 'warning', 'critical'])

// `percent` in `limits[]` is documented as 0-100 and is an integer in practice,
// so — unlike `utilization` — it gets no fraction heuristic. Treating a
// `percent: 1` entry as a 0-1 fraction would render 1% used as 100% used.
function clampPercent(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return Math.max(0, Math.min(100, raw))
}

function limitWindow(entry: Record<string, unknown>): RateWindow | null {
  const pct = clampPercent(entry.percent)
  if (pct === null) return null
  const resetsAt = typeof entry.resets_at === 'string' ? entry.resets_at : null
  return { usedPercent: pct, resetsAt, resetText: formatResetText(resetsAt) }
}

// Scope shape varies by limit type (model today, surface reserved). Prefer the
// model's display name, fall back to the surface, and only then to a generic
// label so an unrecognized scope still renders as *something* rather than
// silently disappearing from the UI.
function scopeLabel(scope: unknown): string {
  if (!scope || typeof scope !== 'object') return 'Scoped'
  const s = scope as Record<string, unknown>
  for (const key of ['model', 'surface']) {
    const part = s[key]
    if (typeof part === 'string' && part) return part
    if (part && typeof part === 'object') {
      const name = (part as Record<string, unknown>).display_name
      if (typeof name === 'string' && name) return name
    }
  }
  return 'Scoped'
}

interface ParsedLimits {
  session: RateWindow | null
  weekly: RateWindow | null
  scoped: ScopedRateWindow[]
}

function parseLimitsArray(raw: unknown): ParsedLimits {
  const out: ParsedLimits = { session: null, weekly: null, scoped: [] }
  if (!Array.isArray(raw)) return out

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const window = limitWindow(entry)
    if (!window) continue

    switch (entry.kind) {
      case 'session':
        out.session ??= window
        break
      case 'weekly_all':
        out.weekly ??= window
        break
      case 'weekly_scoped': {
        const severity = typeof entry.severity === 'string' && SEVERITIES.has(entry.severity)
          ? (entry.severity as ScopedRateWindow['severity'])
          : 'normal'
        out.scoped.push({
          ...window,
          label: scopeLabel(entry.scope),
          severity,
          isActive: entry.is_active === true,
        })
        break
      }
    }
  }

  return out
}

export function parseClaudeUsageResponse(body: unknown): ClaudeUsagePayload {
  if (!body || typeof body !== 'object') {
    return { session: null, weekly: null, scoped: [] }
  }
  const b = body as Record<string, unknown>

  // `limits[]` wins where it has an entry, but fall back per-window rather than
  // all-or-nothing so a response that carries only some kinds still fills the
  // rest from the legacy fields.
  const limits = parseLimitsArray(b.limits)

  // Nested shape: { five_hour: {utilization, resets_at}, seven_day: {...} }
  const nestedSession = extractWindow(b.five_hour)
  const nestedWeekly = extractWindow(b.seven_day)
  if (nestedSession || nestedWeekly) {
    return {
      session: limits.session ?? nestedSession,
      weekly: limits.weekly ?? nestedWeekly,
      scoped: limits.scoped,
    }
  }

  // Flat shape (ccline-style): { five_hour_utilization, seven_day_utilization, resets_at }
  const sessionPct = normalizePercent(b.five_hour_utilization)
  const weeklyPct = normalizePercent(b.seven_day_utilization)
  const resetsAt = typeof b.resets_at === 'string' ? b.resets_at : null

  return {
    // Flat shape carries only a single resets_at, which maps to the weekly window.
    session: limits.session ?? (sessionPct !== null
      ? { usedPercent: sessionPct, resetsAt: null, resetText: null }
      : null),
    weekly: limits.weekly ?? (weeklyPct !== null
      ? { usedPercent: weeklyPct, resetsAt, resetText: formatResetText(resetsAt) }
      : null),
    scoped: limits.scoped,
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
      return { ok: false, error: 'token-expired', status: res.status }
    }
    if (res.status === 429) {
      let detail: string | undefined
      try {
        detail = (await res.text()).slice(0, 200)
      } catch {}
      return { ok: false, error: 'rate-limited', status: 429, detail }
    }
    if (!res.ok) {
      let detail: string | undefined
      try {
        detail = (await res.text()).slice(0, 200)
      } catch {}
      return { ok: false, error: 'request-failed', status: res.status, detail }
    }

    let body: unknown
    try {
      body = await res.json()
    } catch (err) {
      return {
        ok: false,
        error: 'request-failed',
        status: res.status,
        detail: err instanceof Error ? err.message : 'invalid json',
      }
    }

    const parsed = parseClaudeUsageResponse(body)
    return { ok: true, ...parsed }
  } catch (err) {
    return { ok: false, error: 'network-error', detail: err instanceof Error ? err.message : undefined }
  } finally {
    clearTimeout(timer)
  }
}
