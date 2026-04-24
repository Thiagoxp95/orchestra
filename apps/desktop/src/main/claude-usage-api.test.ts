import { describe, it, expect } from 'vitest'
import { parseClaudeUsageResponse, fetchClaudeUsage } from './claude-usage-api'

describe('parseClaudeUsageResponse', () => {
  it('parses the ccline-style flat shape (percentages 0-100)', () => {
    const parsed = parseClaudeUsageResponse({
      five_hour_utilization: 14.0,
      seven_day_utilization: 5.0,
      resets_at: '2026-04-27T18:00:00.000Z',
    })

    expect(parsed.session).toEqual({ usedPercent: 14, resetsAt: null })
    expect(parsed.weekly).toEqual({ usedPercent: 5, resetsAt: '2026-04-27T18:00:00.000Z' })
  })

  it('parses the nested shape (percentages 0-100 with per-window resets_at)', () => {
    const parsed = parseClaudeUsageResponse({
      five_hour: { utilization: 42, resets_at: '2026-04-23T22:00:00Z' },
      seven_day: { utilization: 5, resets_at: '2026-04-27T18:00:00Z' },
    })

    expect(parsed.session).toEqual({ usedPercent: 42, resetsAt: '2026-04-23T22:00:00Z' })
    expect(parsed.weekly).toEqual({ usedPercent: 5, resetsAt: '2026-04-27T18:00:00Z' })
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

  it('returns rate-limited on 429 and honors Retry-After in seconds', async () => {
    const fetchFn: typeof fetch = async () =>
      new Response('too many requests', { status: 429, headers: { 'retry-after': '120' } })

    const res = await fetchClaudeUsage({ accessToken }, { fetchFn })
    expect(res).toMatchObject({
      ok: false,
      error: 'rate-limited',
      status: 429,
      retryAfterMs: 120_000,
      detail: 'too many requests',
    })
  })

  it('defaults to a 30-minute cooldown on 429 without Retry-After', async () => {
    const fetchFn: typeof fetch = async () => new Response('', { status: 429 })

    const res = await fetchClaudeUsage({ accessToken }, { fetchFn })
    expect(res).toMatchObject({
      ok: false,
      error: 'rate-limited',
      status: 429,
      retryAfterMs: 30 * 60 * 1000,
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
