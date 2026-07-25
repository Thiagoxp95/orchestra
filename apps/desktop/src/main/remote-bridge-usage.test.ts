import { describe, it, expect } from 'vitest'
import { sanitizeUsage, usageFingerprint } from './remote-bridge-usage'
import type { UsageSnapshot } from '../shared/types'

function snapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    claude: { probe: null, scan: null, isSyncing: false },
    codex: { probe: null, scan: null, isSyncing: false },
    ...over,
  }
}

const claudeProbe = {
  provider: 'claude' as const,
  session: { usedPercent: 45, resetsAt: null, resetText: 'Resets in 2h' },
  weekly: { usedPercent: 72, resetsAt: null, resetText: 'Resets in 3d' },
  error: null,
  updatedAt: 1000,
}

describe('sanitizeUsage', () => {
  it('returns null when no provider has data', () => {
    expect(sanitizeUsage(snapshot())).toBeNull()
    expect(sanitizeUsage(null)).toBeNull()
  })

  it('compacts probe windows and keeps reset copy', () => {
    const out = sanitizeUsage(snapshot({ claude: { probe: claudeProbe, scan: null, isSyncing: false } }))
    expect(out?.claude.session).toEqual({ usedPercent: 45, resetText: 'Resets in 2h' })
    expect(out?.claude.weekly).toEqual({ usedPercent: 72, resetText: 'Resets in 3d' })
    expect(out?.claude.stale).toBe(false)
    expect(out?.codex.session).toBeNull()
  })

  it('drops scan payloads and isSyncing', () => {
    const out = sanitizeUsage(
      snapshot({
        claude: {
          probe: claudeProbe,
          scan: {
            provider: 'claude',
            todayMessages: 12,
            todayTokensIn: 999,
            todayTokensOut: 999,
            todayCostEstimate: 4.2,
            last30Days: [],
            modelBreakdown: [],
            updatedAt: 5,
          },
          isSyncing: true,
        },
      }),
    )
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain('todayCostEstimate')
    expect(serialized).not.toContain('isSyncing')
  })

  it('carries scoped windows with their label and severity', () => {
    const out = sanitizeUsage(
      snapshot({
        claude: {
          probe: {
            ...claudeProbe,
            scoped: [
              { label: 'Fable', usedPercent: 90, resetsAt: null, resetText: null, severity: 'critical', isActive: true },
            ],
          },
          scan: null,
          isSyncing: false,
        },
      }),
    )
    expect(out?.claude.scoped).toEqual([
      { label: 'Fable', usedPercent: 90, resetText: null, severity: 'critical' },
    ])
  })

  it('marks a provider stale when its probe carries an error', () => {
    const out = sanitizeUsage(
      snapshot({
        claude: {
          probe: { ...claudeProbe, error: 'rate-limited' },
          scan: null,
          isSyncing: false,
        },
      }),
    )
    expect(out?.claude.stale).toBe(true)
    // Last good numbers survive the error — that's what the badge keeps showing.
    expect(out?.claude.session?.usedPercent).toBe(45)
  })

  it('ignores non-finite percentages rather than mirroring NaN', () => {
    const out = sanitizeUsage(
      snapshot({
        claude: {
          probe: { ...claudeProbe, session: { usedPercent: NaN, resetsAt: null, resetText: null } },
          scan: null,
          isSyncing: false,
        },
      }),
    )
    expect(out?.claude.session).toBeNull()
    expect(out?.claude.weekly?.usedPercent).toBe(72)
  })
})

describe('usageFingerprint', () => {
  const base = snapshot({ claude: { probe: claudeProbe, scan: null, isSyncing: false } })

  it('is stable when only updatedAt / isSyncing move', () => {
    const a = usageFingerprint(sanitizeUsage(base))
    const b = usageFingerprint(
      sanitizeUsage(
        snapshot({ claude: { probe: { ...claudeProbe, updatedAt: 99999 }, scan: null, isSyncing: true } }),
      ),
    )
    expect(a).toBe(b)
  })

  it('changes when a percentage moves', () => {
    const a = usageFingerprint(sanitizeUsage(base))
    const b = usageFingerprint(
      sanitizeUsage(
        snapshot({
          claude: {
            probe: { ...claudeProbe, session: { usedPercent: 46, resetsAt: null, resetText: 'Resets in 2h' } },
            scan: null,
            isSyncing: false,
          },
        }),
      ),
    )
    expect(a).not.toBe(b)
  })

  it('changes when a provider goes stale', () => {
    const a = usageFingerprint(sanitizeUsage(base))
    const b = usageFingerprint(
      sanitizeUsage(
        snapshot({ claude: { probe: { ...claudeProbe, error: 'network-error' }, scan: null, isSyncing: false } }),
      ),
    )
    expect(a).not.toBe(b)
  })

  it('is empty for a null payload', () => {
    expect(usageFingerprint(null)).toBe('')
  })
})
