import { describe, it, expect } from 'vitest'
import { selectUsageChips, resolveLevel, levelColor, hasUsage } from './usage'

const mirrored = {
  claude: {
    session: { usedPercent: 45, resetText: 'Resets in 2h' },
    weekly: { usedPercent: 72, resetText: null },
    scoped: [{ label: 'Fable', usedPercent: 90, resetText: null, severity: 'critical' }],
    stale: false,
  },
  codex: {
    session: { usedPercent: 12, resetText: null },
    weekly: null,
    scoped: [],
    stale: false,
  },
}

describe('selectUsageChips', () => {
  it('returns nothing for missing or malformed payloads', () => {
    expect(selectUsageChips(undefined)).toEqual([])
    expect(selectUsageChips(null)).toEqual([])
    expect(selectUsageChips('nope')).toEqual([])
    expect(selectUsageChips({})).toEqual([])
  })

  it('builds one chip per provider, session then weekly then scoped', () => {
    const chips = selectUsageChips(mirrored)
    expect(chips.map((c) => c.id)).toEqual(['claude', 'codex'])
    expect(chips[0].meters.map((m) => m.label)).toEqual(['Sess', 'Week', 'Fable'])
    expect(chips[0].meters[0].percent).toBe(45)
    expect(chips[1].meters.map((m) => m.label)).toEqual(['Sess'])
  })

  it('only draws a label for scoped windows — the standard two go by position', () => {
    const chips = selectUsageChips(mirrored)
    expect(chips[0].meters.map((m) => m.inlineLabel)).toEqual([null, null, 'Fable'])
  })

  it('skips a provider with no usable window', () => {
    const chips = selectUsageChips({ ...mirrored, codex: { session: null, weekly: null, scoped: [] } })
    expect(chips.map((c) => c.id)).toEqual(['claude'])
  })

  it('clamps out-of-range percentages', () => {
    const chips = selectUsageChips({ claude: { session: { usedPercent: 140 }, weekly: { usedPercent: -3 } } })
    expect(chips[0].meters.map((m) => m.percent)).toEqual([100, 0])
  })

  it('drops windows whose percentage is not a finite number', () => {
    const chips = selectUsageChips({
      claude: { session: { usedPercent: 'lots' }, weekly: { usedPercent: 30 } },
    })
    expect(chips[0].meters.map((m) => m.label)).toEqual(['Week'])
  })

  it('ignores scoped entries without a label', () => {
    const chips = selectUsageChips({
      claude: { session: { usedPercent: 10 }, scoped: [{ usedPercent: 90 }, { label: 'Opus', usedPercent: 60 }] },
    })
    expect(chips[0].meters.map((m) => m.label)).toEqual(['Sess', 'Opus'])
  })

  it('flags a stale provider and says so in the summary', () => {
    const chips = selectUsageChips({ claude: { session: { usedPercent: 45 }, stale: true } })
    expect(chips[0].stale).toBe(true)
    expect(chips[0].summary).toContain('last known')
  })

  it('summarizes each window with its reset copy for the aria-label', () => {
    expect(selectUsageChips(mirrored)[0].summary).toBe(
      'Claude usage — Sess 45% (Resets in 2h), Week 72%, Fable 90%',
    )
  })
})

describe('resolveLevel', () => {
  it('derives a level from the percentage', () => {
    expect(resolveLevel(10)).toBe('normal')
    expect(resolveLevel(50)).toBe('warning')
    expect(resolveLevel(80)).toBe('critical')
  })

  it('escalates to the API severity when it is worse', () => {
    expect(resolveLevel(20, 'critical')).toBe('critical')
    expect(resolveLevel(10, 'warning')).toBe('warning')
  })

  it('never de-escalates a high percentage the API calls normal', () => {
    expect(resolveLevel(95, 'normal')).toBe('critical')
  })

  it('treats unknown severities as normal', () => {
    expect(resolveLevel(10, 'spicy')).toBe('normal')
    expect(resolveLevel(10, undefined)).toBe('normal')
  })
})

describe('levelColor', () => {
  it('matches the desktop UsageBar palette', () => {
    expect(levelColor('normal')).toBe('#22c55e')
    expect(levelColor('warning')).toBe('#eab308')
    expect(levelColor('critical')).toBe('#ef4444')
  })
})

describe('hasUsage', () => {
  it('tracks whether the strip will render anything', () => {
    expect(hasUsage(mirrored)).toBe(true)
    expect(hasUsage(undefined)).toBe(false)
    expect(hasUsage({ claude: { session: null, weekly: null, scoped: [] } })).toBe(false)
  })
})
