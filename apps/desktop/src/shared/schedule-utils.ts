import type { AutomationSchedule } from './types'

/** Convert JS Date.getDay() (0=Sun) to ISO 8601 (1=Mon, 7=Sun) */
export function jsToIsoDay(jsDay: number): number {
  return jsDay === 0 ? 7 : jsDay
}

/** "HH:MM" → minutes since midnight. */
export function toMinutesOfDay(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

/** Is a minutes-of-day instant inside the blackout? Blocked range is [start, end); start > end wraps midnight. */
export function isBlackedOut(
  minutesOfDay: number,
  blackout: { start: string; end: string }
): boolean {
  const start = toMinutesOfDay(blackout.start)
  const end = toMinutesOfDay(blackout.end)
  if (start < end) return minutesOfDay >= start && minutesOfDay < end
  return minutesOfDay >= start || minutesOfDay < end
}

/** Validate a schedule. Returns null if valid, error string if invalid. */
export function validateSchedule(schedule: AutomationSchedule): string | null {
  const validTime = (t: string) => {
    if (!/^\d{2}:\d{2}$/.test(t)) return false
    const [h, m] = t.split(':').map(Number)
    return h >= 0 && h <= 23 && m >= 0 && m <= 59
  }

  if (schedule.blackout) {
    const { start, end } = schedule.blackout
    if (!validTime(start) || !validTime(end)) return 'Blackout times must be HH:MM'
    if (toMinutesOfDay(start) === toMinutesOfDay(end)) return 'Blackout: start and end must differ'
  }

  if (schedule.mode === 'daily') {
    if (!/^\d{2}:\d{2}$/.test(schedule.time)) return 'Time must be HH:MM format'
    const [h, m] = schedule.time.split(':').map(Number)
    if (h < 0 || h > 23 || m < 0 || m > 59) return 'Invalid time'
    if (!schedule.days.length) return 'Select at least one day'
    if (schedule.days.some((d) => d < 1 || d > 7)) return 'Days must be 1-7'
    if (schedule.blackout && isBlackedOut(toMinutesOfDay(schedule.time), schedule.blackout)) {
      return 'Daily run time falls inside the blackout window'
    }
    return null
  }
  if (schedule.mode === 'interval') {
    if (!Number.isInteger(schedule.intervalMinutes) || schedule.intervalMinutes < 1) {
      return 'Interval must be a positive integer'
    }
    if (!schedule.days.length) return 'Select at least one day'
    if (schedule.days.some((d) => d < 1 || d > 7)) return 'Days must be 1-7'
    if (schedule.window) {
      const { start, end } = schedule.window
      if (!validTime(start) || !validTime(end)) return 'Active hours must be HH:MM'
      if (toMinutesOfDay(start) >= toMinutesOfDay(end)) return 'Active hours: start must be before end'
      if (schedule.blackout) {
        const ws = toMinutesOfDay(start)
        const we = toMinutesOfDay(end)
        const bs = toMinutesOfDay(schedule.blackout.start)
        const be = toMinutesOfDay(schedule.blackout.end)
        // Active hours [ws, we] (end-inclusive, non-wrapping) fully inside the blocked
        // set ⇒ can never run. For a wrapping blackout the two blocked pieces touch the
        // day edges, so containment means both endpoints sit in the same piece.
        const contained = bs < be ? ws >= bs && we < be : ws >= bs || we < be
        if (contained) return 'Active hours are entirely inside the blackout window'
      }
    }
    return null
  }
  if (schedule.mode === 'cron') {
    if (!schedule.cronExpression.trim()) return 'Cron expression is required'
    return null
  }
  return 'Unknown schedule mode'
}

/** Format a countdown string from a target timestamp. */
export function formatCountdown(targetMs: number, nowMs: number = Date.now()): string {
  const diff = targetMs - nowMs
  if (diff <= 0) return 'now'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  if (hours < 24) return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}
