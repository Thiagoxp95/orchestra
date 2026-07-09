# Automation Blackout Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-automation blackout window ("no runs 5pm–9am") enforced inside `computeNextRunAt`, configured with a wrap-around two-thumb slider in the schedule dialog.

**Architecture:** A new optional `blackout: { start, end }` field shared by all three schedule modes. `computeNextRunAt` wraps the existing per-mode logic in a skip loop that discards candidates landing inside the blackout, so both engines (in-app scheduler, daemon) inherit the behavior with zero engine changes. Validation rejects configs that could never run. A new custom `BlackoutSlider` React component renders the red range.

**Tech Stack:** TypeScript, Electron (electron-vite), React + Tailwind classes with inline `wsColor`-derived styles, vitest.

**Spec:** `docs/superpowers/specs/2026-07-08-automation-blackout-window-design.md` — read it first; the Decisions section defines the semantics implemented here.

## Global Constraints

- Blackout semantics: blocked range is **[start, end)** in minutes-of-day; `start > end` wraps midnight; `start === end` is invalid. Times are `"HH:MM"` 24h strings.
- `blackout` absent ⇒ behavior must be byte-identical to today. No migration.
- No changes to `automation-scheduler.ts` or `daemon.ts`.
- Repo is a bun workspace. Run tests from `apps/desktop/`: `npx vitest run <file>`. Typecheck from `apps/desktop/`: `npm run typecheck`.
- Commit directly to `main` (solo repo, no PRs). Every commit message ends with the trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- All paths below are relative to the repo root `/Users/tedyeng1/Tedy/orchestra`.

---

### Task 1: Data model + blackout predicate helpers

**Files:**
- Modify: `apps/desktop/src/shared/types.ts:99-108` (the `AutomationSchedule` type)
- Modify: `apps/desktop/src/shared/schedule-utils.ts` (add two exported helpers)
- Test: `apps/desktop/src/shared/schedule-utils.test.ts` (append a describe block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AutomationSchedule` gains optional `blackout?: { start: string; end: string }` on every mode variant; `toMinutesOfDay(t: string): number`; `isBlackedOut(minutesOfDay: number, blackout: { start: string; end: string }): boolean`. Tasks 2, 3, 5 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/shared/schedule-utils.test.ts` (it already imports `describe, it, expect` from vitest — extend the existing import from `'./schedule-utils'` to include the new names):

```ts
import { validateSchedule, toMinutesOfDay, isBlackedOut } from './schedule-utils'
```

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && npx vitest run src/shared/schedule-utils.test.ts`
Expected: FAIL — `isBlackedOut`/`toMinutesOfDay` are not exported.

- [ ] **Step 3: Implement**

In `apps/desktop/src/shared/types.ts`, replace the `AutomationSchedule` definition (currently lines 99–108) with:

```ts
// Automation schedule — discriminated union by mode, plus a mode-independent blackout
export type AutomationSchedule = (
  | { mode: 'daily'; time: string; days: number[] }
  | {
      mode: 'interval'
      intervalMinutes: number
      days: number[]
      window?: { start: string; end: string } // "HH:MM"–"HH:MM", end inclusive; absent = all-day
    }
  | { mode: 'cron'; cronExpression: string }
) & {
  blackout?: { start: string; end: string } // "HH:MM"; [start, end) blocked; start > end wraps midnight
}
```

In `apps/desktop/src/shared/schedule-utils.ts`, add below `jsToIsoDay`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && npx vitest run src/shared/schedule-utils.test.ts`
Expected: PASS (all pre-existing tests plus 3 new).

- [ ] **Step 5: Typecheck and commit**

Run: `cd apps/desktop && npm run typecheck` — expected clean (the intersection type is additive).

```bash
git add apps/desktop/src/shared/types.ts apps/desktop/src/shared/schedule-utils.ts apps/desktop/src/shared/schedule-utils.test.ts
git commit -m "feat(automations): blackout field on schedules + blocked-range predicate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Blackout validation rules

**Files:**
- Modify: `apps/desktop/src/shared/schedule-utils.ts` (the `validateSchedule` function)
- Test: `apps/desktop/src/shared/schedule-utils.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `toMinutesOfDay`, `isBlackedOut` from Task 1.
- Produces: `validateSchedule` rejects malformed/degenerate blackouts. Signature unchanged: `(schedule: AutomationSchedule) => string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/shared/schedule-utils.test.ts` (the file already defines the `interval` helper `(window?) => AutomationSchedule`):

```ts
const withBlackout = (
  schedule: AutomationSchedule,
  blackout: { start: string; end: string }
): AutomationSchedule => ({ ...schedule, blackout })

describe('validateSchedule — blackout', () => {
  const daily: AutomationSchedule = { mode: 'daily', time: '12:00', days: [1, 2, 3, 4, 5] }
  it('accepts a wrapping blackout (start > end)', () => {
    expect(validateSchedule(withBlackout(daily, { start: '17:00', end: '09:00' }))).toBeNull()
  })
  it('accepts a non-wrapping blackout', () => {
    expect(validateSchedule(withBlackout(daily, { start: '13:00', end: '15:00' }))).toBeNull()
  })
  it('rejects malformed blackout times', () => {
    expect(validateSchedule(withBlackout(daily, { start: '5pm', end: '09:00' }))).not.toBeNull()
    expect(validateSchedule(withBlackout(daily, { start: '17:00', end: '24:00' }))).not.toBeNull()
  })
  it('rejects start === end', () => {
    expect(validateSchedule(withBlackout(daily, { start: '09:00', end: '09:00' }))).not.toBeNull()
  })
  it('rejects a daily time inside the blackout (never runs)', () => {
    expect(validateSchedule(withBlackout({ ...daily, time: '18:00' }, { start: '17:00', end: '09:00' }))).not.toBeNull()
    expect(validateSchedule(withBlackout({ ...daily, time: '08:00' }, { start: '17:00', end: '09:00' }))).not.toBeNull()
  })
  it('accepts a daily time exactly at blackout end (end-exclusive)', () => {
    expect(validateSchedule(withBlackout({ ...daily, time: '09:00' }, { start: '17:00', end: '09:00' }))).toBeNull()
  })
  it('rejects active hours fully inside a wrapping blackout', () => {
    expect(validateSchedule(withBlackout(interval({ start: '18:00', end: '20:00' }), { start: '17:00', end: '09:00' }))).not.toBeNull()
    expect(validateSchedule(withBlackout(interval({ start: '06:00', end: '08:00' }), { start: '17:00', end: '09:00' }))).not.toBeNull()
  })
  it('accepts active hours straddling the blackout gap (endpoints blocked, middle allowed)', () => {
    expect(validateSchedule(withBlackout(interval({ start: '08:00', end: '18:00' }), { start: '17:00', end: '09:00' }))).toBeNull()
  })
  it('rejects active hours fully inside a non-wrapping blackout', () => {
    expect(validateSchedule(withBlackout(interval({ start: '13:30', end: '14:30' }), { start: '13:00', end: '15:00' }))).not.toBeNull()
  })
  it('cron with blackout is accepted (no static check possible)', () => {
    expect(validateSchedule(withBlackout({ mode: 'cron', cronExpression: '0 3 * * *' }, { start: '17:00', end: '09:00' }))).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && npx vitest run src/shared/schedule-utils.test.ts`
Expected: FAIL — the blackout-rejection cases return `null` today.

- [ ] **Step 3: Implement**

Replace the whole `validateSchedule` function in `apps/desktop/src/shared/schedule-utils.ts` with the version below. Behavior notes: the format/`start!==end` checks run for every mode; the old interval-window branch's local `valid`/`toMin` helpers are folded into the shared `validTime`/`toMinutesOfDay` (identical behavior); the two degenerate never-runs configs are rejected.

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && npx vitest run src/shared/schedule-utils.test.ts`
Expected: PASS — all pre-existing window tests still pass (same messages/behavior) plus the new blackout block.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/schedule-utils.ts apps/desktop/src/shared/schedule-utils.test.ts
git commit -m "feat(automations): validate blackout window, reject never-runs configs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Blackout-aware computeNextRunAt

**Files:**
- Modify: `apps/desktop/src/main/schedule-computation.ts`
- Test: `apps/desktop/src/main/schedule-computation.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `isBlackedOut` from Task 1 (`../shared/schedule-utils`).
- Produces: `computeNextRunAt(schedule, lastRunAt, now?)` — public signature unchanged; returned timestamp is never inside the blackout. Internal-only: `computeBaseNextRun`, `blackoutEndAfter`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/main/schedule-computation.test.ts` (reuses the existing `at()` helper and `BIZ`; date anchors: 2026-06-26 Fri, 06-27 Sat, 06-28 Sun):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && npx vitest run src/main/schedule-computation.test.ts`
Expected: FAIL — the new block fails (blackout ignored today); the 9 pre-existing tests still pass.

- [ ] **Step 3: Implement**

Rewrite `apps/desktop/src/main/schedule-computation.ts`. The existing body of `computeNextRunAt` moves verbatim into a private `computeBaseNextRun` (drop its `= Date.now()` default); the public function becomes the skip loop. `findNextAllowedDay` and `computeWindowedNextRun` are unchanged. Top of file becomes:

```ts
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
  // …existing computeNextRunAt body, verbatim (cron / interval / daily branches)…
}
```

(The `// …existing…` line is the one place you copy code that already exists in the file rather than from this plan — move the current function body without edits.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && npx vitest run src/main/schedule-computation.test.ts`
Expected: PASS — 9 pre-existing + 8 new.

- [ ] **Step 5: Run the full suite + typecheck, then commit**

Run: `cd apps/desktop && npx vitest run && npm run typecheck`
Expected: all test files pass; typecheck clean.

```bash
git add apps/desktop/src/main/schedule-computation.ts apps/desktop/src/main/schedule-computation.test.ts
git commit -m "feat(automations): skip runs inside the blackout window in computeNextRunAt

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: BlackoutSlider component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/BlackoutSlider.tsx`

**Interfaces:**
- Consumes: nothing from other tasks (self-contained; times as `"HH:MM"` strings).
- Produces: `BlackoutSlider({ value: { start: string; end: string }, onChange: (v) => void, txt: string, trackBg: string })` — controlled component; Task 5 imports it by this exact name/props.

No unit tests: renderer components in this codebase have no component tests (consistent with `Toggle`, `DayPicker`); verification is typecheck + the manual QA step in Task 5.

- [ ] **Step 1: Create the component**

Create `apps/desktop/src/renderer/src/components/BlackoutSlider.tsx`:

```tsx
import { useRef } from 'react'

const DAY_MIN = 24 * 60
const STEP_MIN = 15
const RED = '#ef4444'

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}
const toHHMM = (min: number): string => {
  const m = ((min % DAY_MIN) + DAY_MIN) % DAY_MIN
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/**
 * Two-thumb 00:00–24:00 slider. The red region between the thumbs is the blackout;
 * when start > end the red region wraps midnight (start→24:00 plus 00:00→end).
 */
export function BlackoutSlider({ value, onChange, txt, trackBg }: {
  value: { start: string; end: string }
  onChange: (v: { start: string; end: string }) => void
  txt: string
  trackBg: string
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const start = toMin(value.start)
  const end = toMin(value.end)
  const wraps = start > end
  const pct = (min: number) => (min / DAY_MIN) * 100

  const setThumb = (thumb: 'start' | 'end', rawMin: number) => {
    const snapped = (((Math.round(rawMin / STEP_MIN) * STEP_MIN) % DAY_MIN) + DAY_MIN) % DAY_MIN
    onChange(thumb === 'start' ? { ...value, start: toHHMM(snapped) } : { ...value, end: toHHMM(snapped) })
  }

  const beginDrag = (thumb: 'start' | 'end') => (e: React.PointerEvent) => {
    e.preventDefault()
    const move = (ev: PointerEvent) => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return
      const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))
      setThumb(thumb, Math.min(DAY_MIN - STEP_MIN, ratio * DAY_MIN))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    move(e.nativeEvent)
  }

  const onKey = (thumb: 'start' | 'end') => (e: React.KeyboardEvent) => {
    const delta =
      e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -STEP_MIN
      : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? STEP_MIN
      : 0
    if (!delta) return
    e.preventDefault()
    setThumb(thumb, (thumb === 'start' ? start : end) + delta)
  }

  const thumbEl = (kind: 'start' | 'end', min: number) => (
    <div
      role="slider"
      tabIndex={0}
      aria-label={kind === 'start' ? 'Blackout start' : 'Blackout end'}
      aria-valuemin={0}
      aria-valuemax={DAY_MIN - STEP_MIN}
      aria-valuenow={min}
      aria-valuetext={toHHMM(min)}
      onPointerDown={beginDrag(kind)}
      onKeyDown={onKey(kind)}
      className="absolute top-1/2 h-4 w-4 rounded-full cursor-grab focus:outline-none"
      style={{
        left: `${pct(min)}%`,
        transform: 'translate(-50%, -50%)',
        backgroundColor: txt,
        border: `2px solid ${RED}`,
      }}
    />
  )

  const redSegment = (fromPct: number, toPct: number) => (
    <div
      className="absolute top-0 h-full rounded-full"
      style={{ left: `${fromPct}%`, width: `${toPct - fromPct}%`, backgroundColor: `${RED}99` }}
    />
  )

  return (
    <div className="px-1">
      <p className="mb-1 text-[10px] opacity-60" style={{ color: txt }}>
        No runs {value.start} – {value.end}{wraps ? ' (overnight)' : ''}
      </p>
      <div ref={trackRef} className="relative h-2 rounded-full" style={{ backgroundColor: trackBg }}>
        {wraps ? (
          <>
            {redSegment(pct(start), 100)}
            {redSegment(0, pct(end))}
          </>
        ) : (
          redSegment(pct(start), pct(end))
        )}
        {thumbEl('start', start)}
        {thumbEl('end', end)}
      </div>
      <div className="mt-1 flex justify-between text-[9px] opacity-40" style={{ color: txt }}>
        <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/desktop && npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/BlackoutSlider.tsx
git commit -m "feat(automations): two-thumb wrap-around blackout slider component

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire the blackout into AddActionDialog

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/AddActionDialog.tsx` (imports ~line 4, state ~line 150, `handleSave` schedule build ~lines 289–302, schedule JSX between the cron block ~line 830 and the "Target worktree" block ~line 832)

**Interfaces:**
- Consumes: `BlackoutSlider` (Task 4), `blackout` field on `AutomationSchedule` (Task 1); `validateSchedule` already runs in `handleSave` and surfaces errors via the existing `scheduleError` paragraph.
- Produces: saved actions carry `schedule.blackout` when the toggle is on.

- [ ] **Step 1: Add import and state**

Add to the imports (next to the `Toggle` import):

```ts
import { BlackoutSlider } from './BlackoutSlider'
```

Add state after the `windowEnd` useState block (after line 149):

```ts
const [blackoutEnabled, setBlackoutEnabled] = useState(!!existingAction?.schedule?.blackout)
const [blackout, setBlackout] = useState<{ start: string; end: string }>(
  existingAction?.schedule?.blackout ?? { start: '17:00', end: '09:00' }
)
```

- [ ] **Step 2: Attach the field in handleSave**

In `handleSave`, replace the three schedule literals (currently lines 291–302) with:

```ts
const blackoutField = blackoutEnabled ? blackout : undefined
if (scheduleMode === 'daily') {
  schedule = { mode: 'daily', time: dailyTime, days: scheduleDays, blackout: blackoutField }
} else if (scheduleMode === 'interval') {
  schedule = {
    mode: 'interval',
    intervalMinutes,
    days: scheduleDays,
    window: activeHours ? { start: windowStart, end: windowEnd } : undefined,
    blackout: blackoutField,
  }
} else if (scheduleMode === 'cron') {
  schedule = { mode: 'cron', cronExpression, blackout: blackoutField }
}
```

- [ ] **Step 3: Render the toggle + slider for all modes**

Insert between the closing of the cron block (`)}` at ~line 830) and the `{/* Target worktree */}` comment:

```tsx
{/* Blackout window — applies to all modes */}
<Toggle
  label="Blackout window"
  value={blackoutEnabled}
  onChange={setBlackoutEnabled}
  txt={txt} mutedTxt={txt} bg={toggleBg}
/>
{blackoutEnabled && (
  <BlackoutSlider value={blackout} onChange={setBlackout} txt={txt} trackBg={inputBg} />
)}
```

- [ ] **Step 4: Typecheck + full test suite**

Run: `cd apps/desktop && npm run typecheck && npx vitest run`
Expected: both clean.

- [ ] **Step 5: Manual QA (dev app)**

Run the desktop app (`cd apps/desktop && npm run dev`), open a workspace → add/edit an action → Schedule:

- Toggle "Blackout window" on: slider appears with red 17:00→24:00 and 00:00→09:00 (wrap default), label "No runs 17:00 – 09:00 (overnight)".
- Drag thumbs: 15-min snapping; dragging start left of end collapses to a single mid-day red segment.
- Set mode `daily`, time 18:00, blackout 17:00–09:00, Save → inline red error "Daily run time falls inside the blackout window"; move time to 12:00 → saves.
- Re-open the saved action → toggle is on and thumbs restore.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/AddActionDialog.tsx
git commit -m "feat(automations): blackout window toggle + slider in schedule dialog

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
