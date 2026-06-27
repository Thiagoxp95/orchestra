import { describe, it, expect } from 'vitest'
import { validateSchedule } from './schedule-utils'
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
