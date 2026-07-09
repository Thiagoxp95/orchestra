import { Cron } from 'croner'
import type { AutomationSchedule } from '../shared/types'
import { jsToIsoDay, isBlackedOut } from '../shared/schedule-utils'

const DAY_MS = 86400000
const SCAN_HORIZON_MS = 14 * DAY_MS
// Generous cap: a 1-minute interval stepping through 14 days is ~20k candidates.
const MAX_SKIP_ITERATIONS = 25000

/** Compute the next run timestamp from a schedule and lastRunAt, skipping blackout hits. */
export function computeNextRunAt(
  schedule: AutomationSchedule,
  lastRunAt: number,
  now: number = Date.now()
): number {
  const blackout = schedule.blackout
  if (!blackout) return computeBaseNextRun(schedule, lastRunAt, now)

  const blocked = (ts: number) => {
    const d = new Date(ts)
    return isBlackedOut(d.getHours() * 60 + d.getMinutes(), blackout)
  }
  const horizon = now + SCAN_HORIZON_MS
  let effLastRunAt = lastRunAt
  let effNow = now
  for (let i = 0; i < MAX_SKIP_ITERATIONS && effNow <= horizon; i++) {
    const candidate = computeBaseNextRun(schedule, effLastRunAt, effNow)
    if (!blocked(candidate)) return candidate
    if (candidate > effNow) {
      // Skip semantics: treat the blocked candidate as having run, look past it.
      effLastRunAt = candidate
      effNow = candidate
    } else {
      // "Run now" bootstrap / overdue clamp landed in the blackout → resume at its end.
      effNow = blackoutEndAfter(candidate, blackout)
    }
  }
  // No schedule-produced run outside the blackout within the horizon (cron-only in
  // practice; daily/interval degenerates are rejected by validateSchedule).
  return blackoutEndAfter(horizon, blackout)
}

/** Earliest instant strictly after ts sitting on a blackout end boundary (never blocked). */
function blackoutEndAfter(ts: number, blackout: { start: string; end: string }): number {
  const [eh, em] = blackout.end.split(':').map(Number)
  for (let offset = 0; offset <= 1; offset++) {
    const d = new Date(ts)
    d.setDate(d.getDate() + offset)
    d.setHours(eh, em, 0, 0)
    if (d.getTime() > ts) return d.getTime()
  }
  return ts + DAY_MS
}

/** Next run per the schedule alone, ignoring any blackout. */
function computeBaseNextRun(
  schedule: AutomationSchedule,
  lastRunAt: number,
  now: number
): number {
  if (schedule.mode === 'cron') {
    const job = new Cron(schedule.cronExpression)
    const next = job.nextRun(new Date(now))
    return next ? next.getTime() : now + 86400000
  }

  if (schedule.mode === 'interval') {
    if (schedule.window) {
      return computeWindowedNextRun(
        schedule.intervalMinutes,
        schedule.days,
        schedule.window,
        now
      )
    }
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

/**
 * Next anchored tick for a windowed interval. Ticks are start, start+interval, …
 * up to and including `end`, on allowed weekdays. Returns the earliest tick
 * strictly after `now`; rolls to the next allowed day's start when today's
 * window is exhausted. Independent of lastRunAt.
 */
function computeWindowedNextRun(
  intervalMinutes: number,
  days: number[],
  window: { start: string; end: string },
  now: number
): number {
  const stepMs = intervalMinutes * 60000
  const [sh, sm] = window.start.split(':').map(Number)
  const [eh, em] = window.end.split(':').map(Number)

  for (let offset = 0; offset <= 14; offset++) {
    const day = new Date(now)
    day.setDate(day.getDate() + offset)
    if (!days.includes(jsToIsoDay(day.getDay()))) continue

    const startMs = new Date(day).setHours(sh, sm, 0, 0)
    const endMs = new Date(day).setHours(eh, em, 0, 0)

    if (now < startMs) return startMs
    if (now < endMs) {
      const nextK = Math.floor((now - startMs) / stepMs) + 1
      const candidate = startMs + nextK * stepMs
      if (candidate <= endMs) return candidate
    }
    // else: now is past this day's last in-window tick → try the next allowed day
  }
  return now + 86400000
}
