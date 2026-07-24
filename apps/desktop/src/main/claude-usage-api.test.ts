import { describe, it, expect } from 'vitest'
import { parseClaudeUsageResponse, fetchClaudeUsage } from './claude-usage-api'

describe('parseClaudeUsageResponse', () => {
  it('parses the ccline-style flat shape (percentages 0-100)', () => {
    const parsed = parseClaudeUsageResponse({
      five_hour_utilization: 14.0,
      seven_day_utilization: 5.0,
      resets_at: '2026-04-27T18:00:00.000Z',
    })

    expect(parsed.session).toMatchObject({ usedPercent: 14, resetsAt: null })
    expect(parsed.weekly).toMatchObject({ usedPercent: 5, resetsAt: '2026-04-27T18:00:00.000Z' })
  })

  it('parses the nested shape (percentages 0-100 with per-window resets_at)', () => {
    const parsed = parseClaudeUsageResponse({
      five_hour: { utilization: 42, resets_at: '2026-04-23T22:00:00Z' },
      seven_day: { utilization: 5, resets_at: '2026-04-27T18:00:00Z' },
    })

    expect(parsed.session).toMatchObject({ usedPercent: 42, resetsAt: '2026-04-23T22:00:00Z' })
    expect(parsed.weekly).toMatchObject({ usedPercent: 5, resetsAt: '2026-04-27T18:00:00Z' })
  })

  it('accepts fractional utilizations (0-1) and converts to percent', () => {
    const parsed = parseClaudeUsageResponse({
      five_hour: { utilization: 0.14 },
      seven_day: { utilization: 0.05 },
    })

    expect(parsed.session?.usedPercent).toBeCloseTo(14, 5)
    expect(parsed.weekly?.usedPercent).toBeCloseTo(5, 5)
  })

  it('clamps percentages into [0,100]', () => {
    const parsed = parseClaudeUsageResponse({
      five_hour_utilization: 150,
      seven_day_utilization: -10,
    })

    expect(parsed.session?.usedPercent).toBe(100)
    expect(parsed.weekly?.usedPercent).toBe(0)
  })

  it('returns nulls for missing fields', () => {
    const parsed = parseClaudeUsageResponse({})
    expect(parsed.session).toBeNull()
    expect(parsed.weekly).toBeNull()
  })

  it('ignores non-object responses', () => {
    expect(parseClaudeUsageResponse(null).session).toBeNull()
    expect(parseClaudeUsageResponse('oops').weekly).toBeNull()
  })

  describe('limits[] shape', () => {
    // Trimmed from a live /api/oauth/usage response. Note the legacy
    // seven_day_opus/sonnet keys are null even while a scoped cap is maxed —
    // limits[] is the only place per-model caps appear.
    const live = {
      five_hour: { utilization: 1.0, resets_at: '2026-07-24T06:59:59Z' },
      seven_day: { utilization: 72.0, resets_at: '2026-07-27T17:59:59Z' },
      seven_day_opus: null,
      seven_day_sonnet: null,
      limits: [
        { kind: 'session', group: 'session', percent: 1, severity: 'normal', resets_at: '2026-07-24T06:59:59Z', scope: null, is_active: false },
        { kind: 'weekly_all', group: 'weekly', percent: 72, severity: 'normal', resets_at: '2026-07-27T17:59:59Z', scope: null, is_active: false },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 100,
          severity: 'critical',
          resets_at: '2026-07-27T17:59:59Z',
          scope: { model: { id: null, display_name: 'Fable' }, surface: null },
          is_active: true,
        },
      ],
    }

    it('surfaces the per-model scoped window', () => {
      const parsed = parseClaudeUsageResponse(live)

      expect(parsed.scoped).toHaveLength(1)
      expect(parsed.scoped[0]).toMatchObject({
        label: 'Fable',
        usedPercent: 100,
        severity: 'critical',
        isActive: true,
        resetsAt: '2026-07-27T17:59:59Z',
      })
    })

    it('reads session/weekly from limits[] rather than the legacy windows', () => {
      const parsed = parseClaudeUsageResponse(live)

      // Regression guard: `utilization: 1.0` goes through the 0-1 fraction
      // heuristic and would read as 100%. The limits[] percent is unambiguous.
      expect(parsed.session?.usedPercent).toBe(1)
      expect(parsed.weekly?.usedPercent).toBe(72)
    })

    it('falls back per-window when limits[] omits a kind', () => {
      const parsed = parseClaudeUsageResponse({
        five_hour: { utilization: 42, resets_at: '2026-04-23T22:00:00Z' },
        seven_day: { utilization: 5, resets_at: '2026-04-27T18:00:00Z' },
        limits: [{ kind: 'weekly_all', percent: 61, resets_at: '2026-04-27T18:00:00Z' }],
      })

      expect(parsed.session?.usedPercent).toBe(42) // legacy five_hour
      expect(parsed.weekly?.usedPercent).toBe(61) // limits[] wins
    })

    it('labels a scoped limit even when the scope is unrecognized', () => {
      const parsed = parseClaudeUsageResponse({
        limits: [
          { kind: 'weekly_scoped', percent: 10, scope: { surface: { display_name: 'Claude Code' } } },
          { kind: 'weekly_scoped', percent: 20, scope: { model: null, surface: null } },
        ],
      })

      expect(parsed.scoped.map((s) => s.label)).toEqual(['Claude Code', 'Scoped'])
      expect(parsed.scoped[1].severity).toBe('normal')
      expect(parsed.scoped[1].isActive).toBe(false)
    })

    it('skips malformed entries instead of dropping the whole array', () => {
      const parsed = parseClaudeUsageResponse({
        limits: [
          null,
          'nope',
          { kind: 'weekly_scoped', percent: 'lots', scope: { model: { display_name: 'Fable' } } },
          { kind: 'weekly_scoped', percent: 150, scope: { model: { display_name: 'Opus' } } },
        ],
      })

      expect(parsed.scoped).toHaveLength(1)
      expect(parsed.scoped[0]).toMatchObject({ label: 'Opus', usedPercent: 100 })
    })

    it('returns an empty scoped list when limits[] is absent', () => {
      expect(parseClaudeUsageResponse({ five_hour_utilization: 12 }).scoped).toEqual([])
    })
  })
})

describe('fetchClaudeUsage', () => {
  const accessToken = 'sk-ant-oat01-test'

  it('returns authenticated: false when no token is provided', async () => {
    const res = await fetchClaudeUsage(null)
    expect(res).toEqual({ ok: false, error: 'not-logged-in' })
  })

  it('returns parsed data on 200', async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ five_hour_utilization: 12, seven_day_utilization: 5, resets_at: 'r' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    const res = await fetchClaudeUsage({ accessToken }, { fetchFn })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.session?.usedPercent).toBe(12)
      expect(res.weekly?.usedPercent).toBe(5)
      expect(res.weekly?.resetsAt).toBe('r')
    }
  })

  it('sends Authorization and anthropic-beta headers', async () => {
    let capturedHeaders: Headers | null = null
    const fetchFn: typeof fetch = async (_url: unknown, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers)
      return new Response('{}', { status: 200 })
    }

    await fetchClaudeUsage({ accessToken }, { fetchFn })
    expect(capturedHeaders!.get('authorization')).toBe(`Bearer ${accessToken}`)
    expect(capturedHeaders!.get('anthropic-beta')).toContain('oauth')
  })

  it('returns expired on 401', async () => {
    const fetchFn: typeof fetch = async () => new Response('', { status: 401 })

    const res = await fetchClaudeUsage({ accessToken }, { fetchFn })
    expect(res).toMatchObject({ ok: false, error: 'token-expired', status: 401 })
  })

  it('returns rate-limited on 429 and surfaces the body for diagnostics', async () => {
    // Mirrors ClaudeBar: the API layer just reports the 429; there is no
    // client-side cooldown computation. Callers decide what to display.
    const fetchFn: typeof fetch = async () =>
      new Response('too many requests', { status: 429, headers: { 'retry-after': '120' } })

    const res = await fetchClaudeUsage({ accessToken }, { fetchFn })
    expect(res).toMatchObject({
      ok: false,
      error: 'rate-limited',
      status: 429,
      detail: 'too many requests',
    })
  })

  it('returns generic error on other non-2xx and includes status/body for diagnosis', async () => {
    const fetchFn: typeof fetch = async () => new Response('oops', { status: 500 })

    const res = await fetchClaudeUsage({ accessToken }, { fetchFn })
    expect(res).toMatchObject({ ok: false, error: 'request-failed', status: 500, detail: 'oops' })
  })

  it('returns network error when fetch throws and captures the error message', async () => {
    const fetchFn: typeof fetch = async () => {
      throw new Error('ENOTFOUND')
    }

    const res = await fetchClaudeUsage({ accessToken }, { fetchFn })
    expect(res).toMatchObject({ ok: false, error: 'network-error', detail: 'ENOTFOUND' })
  })
})
