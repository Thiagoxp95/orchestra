import { describe, it, expect } from 'vitest'
// From usage-model, not usage-manager: the manager reaches electron,
// electron-store and a BrowserWindow at import time, none of which exist here.
import { mergeProbeResult, nextClaudeBackoffMs } from './usage-model'
import type { UsageProbeResult } from '../shared/types'

const baseProbe = (overrides: Partial<UsageProbeResult> = {}): UsageProbeResult => ({
  provider: 'claude',
  session: { usedPercent: 12, resetsAt: null, resetText: null },
  weekly: { usedPercent: 5, resetsAt: null, resetText: null },
  error: null,
  updatedAt: 1_000,
  ...overrides,
})

const failedProbe = (overrides: Partial<UsageProbeResult> = {}): UsageProbeResult => ({
  provider: 'claude',
  session: null,
  weekly: null,
  error: 'Rate-limited — backing off',
  updatedAt: 2_000,
  ...overrides,
})

describe('mergeProbeResult', () => {
  it('replaces with the next probe when next has data', () => {
    const prev = baseProbe()
    const next = baseProbe({ session: { usedPercent: 30, resetsAt: null, resetText: null }, updatedAt: 9_000 })
    const merged = mergeProbeResult(prev, next)
    expect(merged).toBe(next)
  })

  it('returns next when there is no previous probe even on failure', () => {
    const next = failedProbe()
    const merged = mergeProbeResult(null, next)
    expect(merged).toBe(next)
  })

  it('returns next when previous had no usable data', () => {
    const prev = failedProbe({ error: 'old error' })
    const next = failedProbe({ error: 'new error', updatedAt: 3_000 })
    const merged = mergeProbeResult(prev, next)
    expect(merged).toBe(next)
  })

  it('preserves previous session/weekly/updatedAt and surfaces new error on failure', () => {
    const prev = baseProbe({ updatedAt: 1_000 })
    const next = failedProbe({ error: 'Rate-limited — backing off', updatedAt: 2_000 })
    const merged = mergeProbeResult(prev, next)
    expect(merged.session).toEqual(prev.session)
    expect(merged.weekly).toEqual(prev.weekly)
    expect(merged.updatedAt).toBe(1_000)
    expect(merged.error).toBe('Rate-limited — backing off')
  })

  it('preserves last good data when only one window was populated', () => {
    const prev = baseProbe({ weekly: null })
    const next = failedProbe({ error: 'Network error' })
    const merged = mergeProbeResult(prev, next)
    expect(merged.session).toEqual(prev.session)
    expect(merged.weekly).toBeNull()
    expect(merged.error).toBe('Network error')
  })
})

describe('nextClaudeBackoffMs', () => {
  it('resets to 0 on a clean probe', () => {
    expect(nextClaudeBackoffMs(0, baseProbe())).toBe(0)
    expect(nextClaudeBackoffMs(240_000, baseProbe())).toBe(0)
    expect(nextClaudeBackoffMs(0, null)).toBe(0)
  })

  it('starts at the base backoff on the first failure', () => {
    expect(nextClaudeBackoffMs(0, failedProbe())).toBe(60_000)
  })

  it('doubles the backoff on consecutive failures', () => {
    expect(nextClaudeBackoffMs(60_000, failedProbe())).toBe(120_000)
    expect(nextClaudeBackoffMs(120_000, failedProbe())).toBe(240_000)
  })

  it('caps the backoff at the ceiling', () => {
    expect(nextClaudeBackoffMs(8 * 60_000, failedProbe())).toBe(10 * 60_000)
    expect(nextClaudeBackoffMs(10 * 60_000, failedProbe())).toBe(10 * 60_000)
  })

  it('backs off on any error, not just rate limits', () => {
    expect(nextClaudeBackoffMs(0, failedProbe({ error: 'Token expired — run claude to refresh' }))).toBe(60_000)
  })
})
