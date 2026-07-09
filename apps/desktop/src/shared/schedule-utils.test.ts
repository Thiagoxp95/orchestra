import { describe, it, expect } from 'vitest'
import { validateSchedule, toMinutesOfDay, isBlackedOut } from './schedule-utils'
import type { AutomationSchedule } from './types'

const interval = (window?: { start: string; end: string }): AutomationSchedule =>
  ({ mode: 'interval', intervalMinutes: 30, days: [1, 2, 3, 4, 5], window })

describe('validateSchedule — interval window', () => {
  it('accepts interval with no window', () => {
    expect(validateSchedule(interval())).toBeNull()
  })
  it('accepts a valid window', () => {
    expect(validateSchedule(interval({ start: '09:00', end: '17:00' }))).toBeNull()
  })
  it('rejects malformed window times', () => {
    expect(validateSchedule(interval({ start: '9:00', end: '17:00' }))).not.toBeNull()
    expect(validateSchedule(interval({ start: '09:00', end: '25:00' }))).not.toBeNull()
  })
  it('rejects an out-of-range minute', () => {
    expect(validateSchedule(interval({ start: '09:60', end: '17:00' }))).not.toBeNull()
  })
  it('rejects start >= end', () => {
    expect(validateSchedule(interval({ start: '17:00', end: '09:00' }))).not.toBeNull()
    expect(validateSchedule(interval({ start: '09:00', end: '09:00' }))).not.toBeNull()
  })
  it('accepts an interval longer than the window (one run/day at start)', () => {
    expect(validateSchedule({ mode: 'interval', intervalMinutes: 600, days: [1, 2, 3, 4, 5], window: { start: '09:00', end: '17:00' } })).toBeNull()
  })
})

describe('isBlackedOut', () => {
  const nonWrap = { start: '13:00', end: '15:00' }
  it('non-wrapping: inside is blocked, outside is not', () => {
    expect(isBlackedOut(toMinutesOfDay('14:00'), nonWrap)).toBe(true)
    expect(isBlackedOut(toMinutesOfDay('12:59'), nonWrap)).toBe(false)
    expect(isBlackedOut(toMinutesOfDay('15:01'), nonWrap)).toBe(false)
  })
  it('boundaries: start inclusive, end exclusive', () => {
    expect(isBlackedOut(toMinutesOfDay('13:00'), nonWrap)).toBe(true)
    expect(isBlackedOut(toMinutesOfDay('15:00'), nonWrap)).toBe(false)
  })
  const wrap = { start: '17:00', end: '09:00' }
  it('wrapping: evening and morning blocked, midday allowed', () => {
    expect(isBlackedOut(toMinutesOfDay('17:00'), wrap)).toBe(true)
    expect(isBlackedOut(toMinutesOfDay('23:59'), wrap)).toBe(true)
    expect(isBlackedOut(toMinutesOfDay('00:00'), wrap)).toBe(true)
    expect(isBlackedOut(toMinutesOfDay('08:59'), wrap)).toBe(true)
    expect(isBlackedOut(toMinutesOfDay('09:00'), wrap)).toBe(false)
    expect(isBlackedOut(toMinutesOfDay('12:00'), wrap)).toBe(false)
    expect(isBlackedOut(toMinutesOfDay('16:59'), wrap)).toBe(false)
  })
})
