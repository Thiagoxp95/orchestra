import { describe, it, expect } from 'vitest'
import { computeNextRunAt } from './schedule-computation'
import type { AutomationSchedule } from '../shared/types'

// 2026-06-26 is a Friday (isoDay 5); 06-27 Sat (6); 06-29 Mon (1).
const BIZ = [1, 2, 3, 4, 5]
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo, d, h, mi, 0, 0).getTime()

const windowed = (intervalMinutes: number, start: string, end: string, days = BIZ): AutomationSchedule =>
  ({ mode: 'interval', intervalMinutes, days, window: { start, end } })

describe('computeNextRunAt — windowed interval', () => {
  it('before the window on an allowed day → today window start', () => {
    const now = at(2026, 5, 26, 7, 30) // Fri 07:30
    expect(computeNextRunAt(windowed(30, '09:00', '17:00'), 0, now)).toBe(at(2026, 5, 26, 9, 0))
  })

  it('mid-window → next anchored tick after now', () => {
    const now = at(2026, 5, 26, 9, 10) // Fri 09:10
    expect(computeNextRunAt(windowed(30, '09:00', '17:00'), 0, now)).toBe(at(2026, 5, 26, 9, 30))
  })

  it('exactly on a tick boundary → the following tick (strict >)', () => {
    const now = at(2026, 5, 26, 9, 30)
    expect(computeNextRunAt(windowed(30, '09:00', '17:00'), 0, now)).toBe(at(2026, 5, 26, 10, 0))
  })

  it('end is inclusive: tick landing on window.end fires', () => {
    const now = at(2026, 5, 26, 16, 45) // last tick before 17:00 is 16:30; next is 17:00
    expect(computeNextRunAt(windowed(30, '09:00', '17:00'), 0, now)).toBe(at(2026, 5, 26, 17, 0))
  })

  it('past window.end rolls to next allowed day window start', () => {
    const now = at(2026, 5, 26, 17, 1) // Fri after 17:00 → skip Sat/Sun → Mon 09:00
    expect(computeNextRunAt(windowed(30, '09:00', '17:00'), 0, now)).toBe(at(2026, 5, 29, 9, 0))
  })

  it('interval not dividing evenly → last tick is the last one <= end', () => {
    const now = at(2026, 5, 26, 16, 40) // 45-min steps from 09:00: …16:30, next 17:15 > 17:00
    expect(computeNextRunAt(windowed(45, '09:00', '17:00'), 0, now)).toBe(at(2026, 5, 29, 9, 0))
  })

  it('disallowed weekday → next allowed day window start', () => {
    const now = at(2026, 5, 27, 10, 0) // Saturday → Monday 09:00
    expect(computeNextRunAt(windowed(30, '09:00', '17:00'), 0, now)).toBe(at(2026, 5, 29, 9, 0))
  })

  it('result is independent of lastRunAt (anchored, not free-running)', () => {
    const now = at(2026, 5, 26, 9, 10)
    const a = computeNextRunAt(windowed(30, '09:00', '17:00'), 0, now)
    const b = computeNextRunAt(windowed(30, '09:00', '17:00'), at(2026, 5, 26, 9, 5), now)
    expect(a).toBe(b)
    expect(a).toBe(at(2026, 5, 26, 9, 30))
  })

  it('regression: interval without a window is unchanged (free-running from lastRunAt)', () => {
    const noWindow: AutomationSchedule = { mode: 'interval', intervalMinutes: 30, days: BIZ }
    const last = at(2026, 5, 26, 9, 0)
    const now = at(2026, 5, 26, 9, 10)
    expect(computeNextRunAt(noWindow, last, now)).toBe(at(2026, 5, 26, 9, 30))
  })
})
