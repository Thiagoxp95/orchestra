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

const ALL = [1, 2, 3, 4, 5, 6, 7]
const wrapBk = { start: '17:00', end: '09:00' } // 5pm → 9am overnight
const midBk = { start: '13:00', end: '15:00' }

describe('computeNextRunAt — blackout window', () => {
  it('free-running interval skips every tick through an overnight blackout', () => {
    const s: AutomationSchedule = { mode: 'interval', intervalMinutes: 60, days: ALL, blackout: wrapBk }
    // last ran Fri 16:00; hourly ticks 17:00…08:00 are all blocked → Sat 09:00
    expect(computeNextRunAt(s, at(2026, 5, 26, 16, 0), at(2026, 5, 26, 16, 5))).toBe(at(2026, 5, 27, 9, 0))
  })

  it('candidate exactly at blackout end fires (end-exclusive)', () => {
    const s: AutomationSchedule = { mode: 'interval', intervalMinutes: 60, days: ALL, blackout: wrapBk }
    expect(computeNextRunAt(s, at(2026, 5, 27, 8, 0), at(2026, 5, 27, 8, 5))).toBe(at(2026, 5, 27, 9, 0))
  })

  it('skip, not defer: blocked ticks resume on the schedule grid, not at blackout end', () => {
    const s: AutomationSchedule = { mode: 'interval', intervalMinutes: 30, days: BIZ, blackout: midBk }
    // last ran Fri 12:40 → 13:10/13:40/14:10/14:40 blocked → 15:10 (NOT 15:00)
    const result = computeNextRunAt(s, at(2026, 5, 26, 12, 40), at(2026, 5, 26, 12, 45))
    expect(result).toBe(at(2026, 5, 26, 15, 10))
    expect(result).not.toBe(at(2026, 5, 26, 15, 0))
  })

  it('anchored (windowed) interval skips blocked ticks; a tick on the blackout end fires', () => {
    const s: AutomationSchedule = {
      mode: 'interval', intervalMinutes: 30, days: BIZ,
      window: { start: '09:00', end: '17:00' }, blackout: midBk,
    }
    // anchored ticks 13:00…14:30 blocked; 15:00 == blackout end → allowed
    expect(computeNextRunAt(s, 0, at(2026, 5, 26, 12, 50))).toBe(at(2026, 5, 26, 15, 0))
  })

  it('daily outside the blackout is unaffected', () => {
    const s: AutomationSchedule = { mode: 'daily', time: '12:00', days: BIZ, blackout: wrapBk }
    expect(computeNextRunAt(s, 0, at(2026, 5, 26, 10, 0))).toBe(at(2026, 5, 26, 12, 0))
  })

  it('cron occurrences inside the blackout are skipped to the next outside one', () => {
    const s: AutomationSchedule = { mode: 'cron', cronExpression: '0 */2 * * *', blackout: wrapBk }
    // Fri 16:30 → 18:00…08:00 all blocked → Sat 10:00
    expect(computeNextRunAt(s, 0, at(2026, 5, 26, 16, 30))).toBe(at(2026, 5, 27, 10, 0))
  })

  it('pathological cron that only fires inside the blackout falls back to a blackout end past the horizon', () => {
    const s: AutomationSchedule = { mode: 'cron', cronExpression: '0 3 * * *', blackout: wrapBk }
    // every candidate (03:00 daily) is blocked; horizon = now+14d (Jul 10 12:00) → first 09:00 after it
    expect(computeNextRunAt(s, 0, at(2026, 5, 26, 12, 0))).toBe(at(2026, 6, 11, 9, 0))
  })

  it('bootstrap "run now" inside the blackout resumes at the blackout end', () => {
    const s: AutomationSchedule = { mode: 'interval', intervalMinutes: 60, days: ALL, blackout: wrapBk }
    // lastRunAt 0 ⇒ base says "now" (Sat 20:00, blocked) → Sun 09:00
    expect(computeNextRunAt(s, 0, at(2026, 5, 27, 20, 0))).toBe(at(2026, 5, 28, 9, 0))
  })
})
