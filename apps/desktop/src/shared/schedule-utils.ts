import type { AutomationSchedule } from './types'

/** Convert JS Date.getDay() (0=Sun) to ISO 8601 (1=Mon, 7=Sun) */
export function jsToIsoDay(jsDay: number): number {
  return jsDay === 0 ? 7 : jsDay
}

/** Validate a schedule. Returns null if valid, error string if invalid. */
export function validateSchedule(schedule: AutomationSchedule): string | null {
  if (schedule.mode === 'daily') {
    if (!/^\d{2}:\d{2}$/.test(schedule.time)) return 'Time must be HH:MM format'
    const [h, m] = schedule.time.split(':').map(Number)
    if (h < 0 || h > 23 || m < 0 || m > 59) return 'Invalid time'
    if (!schedule.days.length) return 'Select at least one day'
    if (schedule.days.some((d) => d < 1 || d > 7)) return 'Days must be 1-7'
    return null
  }
  if (schedule.mode === 'interval') {
    if (!Number.isInteger(schedule.intervalMinutes) || schedule.intervalMinutes < 1) {
      return 'Interval must be a positive integer'
    }
    if (!schedule.days.length) return 'Select at least one day'
    if (schedule.days.some((d) => d < 1 || d > 7)) return 'Days must be 1-7'
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
