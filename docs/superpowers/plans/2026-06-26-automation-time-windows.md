# Automation Time-Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let interval automations run only within a daily time window (e.g. every 30 min from 9am to 5pm on business days), with run times anchored to the window start.

**Architecture:** Add an optional `window?: { start, end }` to the `interval` variant of `AutomationSchedule`. The pure function `computeNextRunAt` gains a window-aware branch that anchors ticks to `window.start` and rolls past the window end / disallowed days. Both firing engines — the in-app scheduler and the closed-app daemon — route through `computeNextRunAt` so the window is one implementation.

**Tech Stack:** TypeScript, Electron (main/renderer/daemon), React, vitest, croner.

## Global Constraints

- Solo repo, no PRs — commit straight to `main` (one commit per task).
- Times are `"HH:MM"` 24h strings; weekday convention is ISO 8601 (1=Mon … 7=Sun); convert JS `getDay()` via `jsToIsoDay` (0→7).
- `window.end` is **inclusive**; ticks are **anchored to `window.start`** (independent of `lastRunAt`).
- `window` is **optional** — absent ⇒ existing all-day behavior, unchanged. No data migration.
- Window applies to **interval mode only**.
- Run tests from `apps/desktop`: `npx vitest run <path>`. Typecheck: `npm run typecheck` (in `apps/desktop`).

---

### Task 1: Window-aware `computeNextRunAt` + data model

**Files:**
- Modify: `apps/desktop/src/shared/types.ts:100-103` (add `window` to interval variant)
- Modify: `apps/desktop/src/main/schedule-computation.ts` (interval branch + new helper)
- Test: `apps/desktop/src/main/schedule-computation.test.ts` (create)

**Interfaces:**
- Consumes: `AutomationSchedule`, `jsToIsoDay` (from `../shared/schedule-utils`).
- Produces: `computeNextRunAt(schedule: AutomationSchedule, lastRunAt: number, now?: number): number` — unchanged signature; new behavior only when an interval schedule has a `window`. Returns a ms timestamp.

- [ ] **Step 1: Add the optional `window` field to the interval variant**

In `apps/desktop/src/shared/types.ts`, change the union (currently lines 100-103) to:

```ts
// Automation schedule — discriminated union by mode
export type AutomationSchedule =
  | { mode: 'daily'; time: string; days: number[] }
  | {
      mode: 'interval'
      intervalMinutes: number
      days: number[]
      window?: { start: string; end: string } // "HH:MM"–"HH:MM", end inclusive; absent = all-day
    }
  | { mode: 'cron'; cronExpression: string }
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/main/schedule-computation.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/schedule-computation.test.ts`
Expected: FAIL — the windowed cases return wrong values (current branch ignores `window`).

- [ ] **Step 4: Implement the window-aware branch**

In `apps/desktop/src/main/schedule-computation.ts`, replace the interval branch (currently lines 17-25) so it delegates to a new helper when a window is set, and add the helper. Keep the no-window path byte-for-byte identical:

```ts
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
```

Add this helper at the bottom of the file (next to `findNextAllowedDay`):

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/schedule-computation.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
cd apps/desktop && npm run typecheck
cd /Users/tedyeng1/Tedy/orchestra
git add apps/desktop/src/shared/types.ts apps/desktop/src/main/schedule-computation.ts apps/desktop/src/main/schedule-computation.test.ts
git commit -m "feat(automations): window-aware interval scheduling (anchored ticks)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Validate the window in `validateSchedule`

**Files:**
- Modify: `apps/desktop/src/shared/schedule-utils.ts:18-25` (interval branch of `validateSchedule`)
- Test: `apps/desktop/src/shared/schedule-utils.test.ts` (create)

**Interfaces:**
- Consumes: `AutomationSchedule`.
- Produces: `validateSchedule(schedule): string | null` — unchanged signature; now also rejects malformed/empty/inverted windows on interval schedules.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/shared/schedule-utils.test.ts`:

```ts
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
  it('rejects start >= end', () => {
    expect(validateSchedule(interval({ start: '17:00', end: '09:00' }))).not.toBeNull()
    expect(validateSchedule(interval({ start: '09:00', end: '09:00' }))).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/shared/schedule-utils.test.ts`
Expected: FAIL — malformed/inverted windows currently return `null` (accepted).

- [ ] **Step 3: Implement window validation**

In `apps/desktop/src/shared/schedule-utils.ts`, replace the interval branch (currently lines 18-25) with:

```ts
  if (schedule.mode === 'interval') {
    if (!Number.isInteger(schedule.intervalMinutes) || schedule.intervalMinutes < 1) {
      return 'Interval must be a positive integer'
    }
    if (!schedule.days.length) return 'Select at least one day'
    if (schedule.days.some((d) => d < 1 || d > 7)) return 'Days must be 1-7'
    if (schedule.window) {
      const { start, end } = schedule.window
      const valid = (t: string) => {
        if (!/^\d{2}:\d{2}$/.test(t)) return false
        const [h, m] = t.split(':').map(Number)
        return h >= 0 && h <= 23 && m >= 0 && m <= 59
      }
      if (!valid(start) || !valid(end)) return 'Active hours must be HH:MM'
      const toMin = (t: string) => {
        const [h, m] = t.split(':').map(Number)
        return h * 60 + m
      }
      if (toMin(start) >= toMin(end)) return 'Active hours: start must be before end'
    }
    return null
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/shared/schedule-utils.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/desktop && npm run typecheck
cd /Users/tedyeng1/Tedy/orchestra
git add apps/desktop/src/shared/schedule-utils.ts apps/desktop/src/shared/schedule-utils.test.ts
git commit -m "feat(automations): validate interval active-hours window

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Route the daemon through `computeNextRunAt`

**Files:**
- Modify: `apps/desktop/src/daemon/daemon.ts` (add import; replace inline recompute at lines 806-814)

**Interfaces:**
- Consumes: `computeNextRunAt` from `../main/schedule-computation`; `AutomationSchedule` from `../shared/types`.
- Produces: no new exports. `DaemonAutomation.nextRunAt` is now computed by the shared helper, so closed-app interval runs honor `days[]` and `window`.

- [ ] **Step 1: Add the import**

In `apps/desktop/src/daemon/daemon.ts`, alongside the existing `../shared/*` imports (the `import type { TerminalLaunchProfile } from '../shared/types'` line near the top), add:

```ts
import { computeNextRunAt } from '../main/schedule-computation'
import type { AutomationSchedule } from '../shared/types'
```

(`croner` is pulled into `daemon.js` by this import but the cron branch is never reached — cron automations cannot `persistWhenClosed`.)

- [ ] **Step 2: Replace the inline recompute**

In the `child.on('close', …)` handler (currently lines 806-814), replace:

```ts
      // Recompute nextRunAt
      const now = Date.now()
      const schedule = auto.schedule
      if (schedule?.mode === 'interval') {
        auto.nextRunAt = now + (schedule.intervalMinutes ?? 60) * 60_000
      } else if (schedule?.mode === 'daily') {
        auto.nextRunAt = now + 86400_000
      }
      auto.lastRunAt = now
```

with:

```ts
      // Recompute nextRunAt via the shared, window/day-aware scheduler so
      // closed-app runs honor days[] and the active-hours window.
      const now = Date.now()
      auto.lastRunAt = now
      if (auto.schedule) {
        auto.nextRunAt = computeNextRunAt(auto.schedule as AutomationSchedule, now, now)
      }
```

- [ ] **Step 3: Typecheck (behavior is covered by Task 1's unit tests)**

Run: `cd apps/desktop && npm run typecheck`
Expected: PASS, no errors. (The daemon's recompute now delegates entirely to `computeNextRunAt`, which Task 1 tested directly. No daemon-level unit test — the runner is side-effect heavy and the logic under change is fully delegated.)

- [ ] **Step 4: Verify the daemon still bundles**

Run: `cd apps/desktop && npm run build`
Expected: build succeeds; `out/main/daemon.js` is regenerated. (Confirms the new import resolves in the daemon rollup entry.)

- [ ] **Step 5: Commit**

```bash
cd /Users/tedyeng1/Tedy/orchestra
git add apps/desktop/src/daemon/daemon.ts
git commit -m "fix(automations): closed-app daemon honors days[] and active-hours window

Routes the daemon recompute through the shared computeNextRunAt instead of a
naive now+interval, fixing the pre-existing bug where closed-app interval runs
ignored the weekday filter.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: "Active hours" toggle in the action dialog

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/AddActionDialog.tsx` (state init ~lines 119-140; interval UI block ~lines 745-764; schedule-build at line 281)

**Interfaces:**
- Consumes: `Toggle` (`./Toggle`, props `{ label, value, onChange, txt, mutedTxt, bg, disabled }`); `validateSchedule`; theme vars already in scope (`txt`, `inputBg`, `inputClass`, `inputStyle`, `toggleBg`).
- Produces: when "Active hours" is on, the built interval schedule includes `window: { start, end }`; when off, `window` is omitted.

- [ ] **Step 1: Add component state for the window**

In `AddActionDialog.tsx`, after the `scheduleDays` state (line 136), add:

```ts
  const [activeHours, setActiveHours] = useState(
    existingAction?.schedule?.mode === 'interval' && !!existingAction.schedule.window
  )
  const [windowStart, setWindowStart] = useState(
    existingAction?.schedule?.mode === 'interval' && existingAction.schedule.window
      ? existingAction.schedule.window.start
      : '09:00'
  )
  const [windowEnd, setWindowEnd] = useState(
    existingAction?.schedule?.mode === 'interval' && existingAction.schedule.window
      ? existingAction.schedule.window.end
      : '17:00'
  )
```

- [ ] **Step 2: Include the window when building the interval schedule**

In the schedule-build (line 281), change:

```ts
      } else if (scheduleMode === 'interval') {
        schedule = { mode: 'interval', intervalMinutes, days: scheduleDays }
      }
```

to:

```ts
      } else if (scheduleMode === 'interval') {
        schedule = {
          mode: 'interval',
          intervalMinutes,
          days: scheduleDays,
          window: activeHours ? { start: windowStart, end: windowEnd } : undefined,
        }
      }
```

(`validateSchedule` from Task 2 already runs on the built schedule at line 286, so a bad window surfaces inline via `scheduleError`.)

- [ ] **Step 3: Render the Active-hours controls in the interval block**

In the interval section, inside the `{scheduleMode === 'interval' && ( … )}` fragment, after the `<DayPicker … />` line (currently line 762) and before the closing `</>`, add:

```tsx
                    <Toggle
                      label="Active hours"
                      value={activeHours}
                      onChange={setActiveHours}
                      txt={txt} mutedTxt={txt} bg={toggleBg}
                    />
                    {activeHours && (
                      <div className="flex items-center gap-2">
                        <div className="flex-1">
                          <label className="block text-xs mb-1 opacity-70" style={{ color: txt }}>From</label>
                          <input
                            type="time"
                            value={windowStart}
                            onChange={(e) => setWindowStart(e.target.value)}
                            className={inputClass}
                            style={inputStyle}
                          />
                        </div>
                        <div className="flex-1">
                          <label className="block text-xs mb-1 opacity-70" style={{ color: txt }}>To</label>
                          <input
                            type="time"
                            value={windowEnd}
                            onChange={(e) => setWindowEnd(e.target.value)}
                            className={inputClass}
                            style={inputStyle}
                          />
                        </div>
                      </div>
                    )}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/desktop && npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 5: Manual smoke (renderer build)**

Run: `cd apps/desktop && npm run build`
Expected: build succeeds. (Optional interactive check: open the action dialog → Schedule → Interval, confirm the "Active hours" toggle reveals From/To time inputs and that saving an inverted window shows the validation error.)

- [ ] **Step 6: Commit**

```bash
cd /Users/tedyeng1/Tedy/orchestra
git add apps/desktop/src/renderer/src/components/AddActionDialog.tsx
git commit -m "feat(automations): active-hours window UI for interval schedules

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Data model (`window?` on interval) → Task 1 Step 1. ✅
- Window-aware anchored computation → Task 1. ✅
- Validation (HH:MM, start<end) → Task 2. ✅
- UI Active-hours toggle → Task 4. ✅
- Daemon unification (honors window + days) → Task 3. ✅
- Tests for computeNextRunAt + validation → Tasks 1 & 2. ✅
- Out of scope (web mirror, multi-window, daily/cron windows) → not implemented, as specified. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands. ✅

**Type consistency:** `window: { start: string; end: string }` identical across types.ts, computeNextRunAt helper, validateSchedule, and the dialog. `computeNextRunAt` signature unchanged everywhere. Daemon casts `auto.schedule as AutomationSchedule`. ✅
