import { Cron } from 'croner'
import type { AutomationSchedule } from '../shared/types'
import { jsToIsoDay } from '../shared/schedule-utils'

/** Compute the next run timestamp from a schedule and lastRunAt. */
export function computeNextRunAt(
  schedule: AutomationSchedule,
  lastRunAt: number,
  now: number = Date.now()
): number {
  if (schedule.mode === 'cron') {
    const job = new Cron(schedule.cronExpression)
    const next = job.nextRun(new Date(now))
    return next ? next.getTime() : now + 86400000
  }

  if (schedule.mode === 'interval') {
    if (lastRunAt === 0) return now
    const candidate = lastRunAt + schedule.intervalMinutes * 60000
    if (candidate <= now) return now
    const candidateDate = new Date(candidate)
    const isoDay = jsToIsoDay(candidateDate.getDay())
    if (schedule.days.includes(isoDay)) return candidate
    return findNextAllowedDay(schedule.days, candidate, schedule.intervalMinutes * 60000)
  }

  if (schedule.mode === 'daily') {
    const [hours, minutes] = schedule.time.split(':').map(Number)
    const today = new Date(now)
    today.setHours(hours, minutes, 0, 0)
    const todayIso = jsToIsoDay(today.getDay())
    if (today.getTime() > now && schedule.days.includes(todayIso)) {
      return today.getTime()
    }
    for (let offset = 1; offset <= 7; offset++) {
      const candidate = new Date(now)
      candidate.setDate(candidate.getDate() + offset)
      candidate.setHours(hours, minutes, 0, 0)
      const isoDay = jsToIsoDay(candidate.getDay())
      if (schedule.days.includes(isoDay)) return candidate.getTime()
    }
    return now + 86400000
  }

  return now + 86400000
}

function findNextAllowedDay(days: number[], from: number, stepMs: number): number {
  let t = from
  for (let i = 0; i < 14; i++) {
    t += stepMs
    const d = new Date(t)
    if (days.includes(jsToIsoDay(d.getDay()))) return t
  }
  return from + 86400000
}
