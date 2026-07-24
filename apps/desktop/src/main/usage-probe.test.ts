import { describe, it, expect, vi } from 'vitest'
import { probeClaudeUsage, probeCodexUsage } from './usage-probe'

describe('probeClaudeUsage', () => {
  it('returns the session/weekly windows on success', async () => {
    const readToken = vi.fn(async () => ({ accessToken: 'abc' }))
    const fetchUsage = vi.fn(async () => ({
      ok: true as const,
      session: { usedPercent: 12, resetsAt: null, resetText: null },
      weekly: { usedPercent: 5, resetsAt: 'r', resetText: 'Resets in 1h 0m' },
      scoped: [
        {
          label: 'Fable',
          usedPercent: 100,
          resetsAt: 'r',
          resetText: 'Resets in 1h 0m',
          severity: 'critical' as const,
          isActive: true,
        },
      ],
    }))

    const res = await probeClaudeUsage({ readToken, fetchUsage })
    expect(res.provider).toBe('claude')
    expect(res.error).toBeNull()
    expect(res.session?.usedPercent).toBe(12)
    expect(res.weekly?.usedPercent).toBe(5)
    expect(res.scoped).toMatchObject([{ label: 'Fable', usedPercent: 100 }])
    expect(fetchUsage).toHaveBeenCalledWith({ accessToken: 'abc' })
  })

  it('keeps a scoped-only response instead of reporting no data', async () => {
    const res = await probeClaudeUsage({
      readToken: async () => ({ accessToken: 'abc' }),
      fetchUsage: async () => ({
        ok: true as const,
        session: null,
        weekly: null,
        scoped: [
          {
            label: 'Fable',
            usedPercent: 100,
            resetsAt: null,
            resetText: null,
            severity: 'critical' as const,
            isActive: true,
          },
        ],
      }),
    })

    expect(res.error).toBeNull()
    expect(res.scoped).toHaveLength(1)
  })

  it('maps not-logged-in to a human error message', async () => {
    const res = await probeClaudeUsage({
      readToken: async () => null,
      fetchUsage: async () => ({ ok: false, error: 'not-logged-in' }),
    })
    expect(res.session).toBeNull()
    expect(res.weekly).toBeNull()
    expect(res.error).toBe('Claude Code not logged in')
  })

  it('maps token-expired to a refresh hint', async () => {
    const res = await probeClaudeUsage({
      readToken: async () => ({ accessToken: 'abc' }),
      fetchUsage: async () => ({ ok: false, error: 'token-expired' }),
    })
    expect(res.error).toContain('Token expired')
  })

  it('maps network errors', async () => {
    const res = await probeClaudeUsage({
      readToken: async () => ({ accessToken: 'abc' }),
      fetchUsage: async () => ({ ok: false, error: 'network-error' }),
    })
    expect(res.error).toBe('Network error')
  })

  it('reports "No utilization data" when both windows are missing', async () => {
    const res = await probeClaudeUsage({
      readToken: async () => ({ accessToken: 'abc' }),
      fetchUsage: async () => ({ ok: true, session: null, weekly: null, scoped: [] }),
    })
    expect(res.error).toBe('No utilization data')
  })
})

describe('probeCodexUsage', () => {
  it('returns windows on ok scan', async () => {
    const res = await probeCodexUsage({
      scan: async () => ({
        kind: 'ok',
        session: { usedPercent: 20, resetsAt: null, resetText: null },
        weekly: { usedPercent: 8, resetsAt: null, resetText: null },
        stale: false,
        ageMs: 5_000,
      }),
    })

    expect(res.provider).toBe('codex')
    expect(res.session?.usedPercent).toBe(20)
    expect(res.error).toBeNull()
  })

  it('flags stale when the scan marks it stale', async () => {
    const res = await probeCodexUsage({
      scan: async () => ({
        kind: 'ok',
        session: { usedPercent: 20, resetsAt: null, resetText: null },
        weekly: null,
        stale: true,
        ageMs: 9 * 3600 * 1000,
      }),
    })

    expect(res.error).toBe('stale')
    expect(res.session?.usedPercent).toBe(20)
  })

  it('maps no-sessions', async () => {
    const res = await probeCodexUsage({
      scan: async () => ({ kind: 'no-sessions' }),
    })

    expect(res.session).toBeNull()
    expect(res.error).toBe('No Codex sessions found')
  })

  it('maps no-recent-rate-limits', async () => {
    const res = await probeCodexUsage({
      scan: async () => ({ kind: 'no-recent-rate-limits' }),
    })

    expect(res.error).toBe('No recent Codex activity')
  })
})
