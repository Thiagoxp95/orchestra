# Automation time-windows (active hours for interval schedules)

**Date:** 2026-06-26
**Status:** Approved, ready for implementation plan

## Problem

Interval automations (`mode: 'interval'`) fire every N minutes around the clock on
the selected weekdays. There is no way to constrain them to a daily time block.

The user wants schedules like *"every 30 minutes from 9am to 5pm on business days."*
The "business days" part is already expressible via `days[]` (Mon–Fri). The missing
piece is the **daily active window** ("9am to 5pm").

## Goal

Add an optional active-hours window to **interval** schedules only. Within the window,
runs are anchored to the window start on clean, predictable times. Outside the window,
the automation does not fire and rolls forward to the next allowed day's start.

## Decisions (locked during brainstorming)

1. **Interval-only.** `daily` is already a single fixed time; `cron` is freeform. A
   window only meaningfully constrains a repeating interval, so it applies to interval
   mode exclusively.
2. **Anchored to window start.** Runs land on deterministic, drift-free times every day:
   for `09:00–17:00` every 30 min → `9:00, 9:30, … 16:30, 17:00`. The sequence resets to
   `window.start` each day and does not depend on `lastRunAt`.
3. **End inclusive.** A tick that lands exactly on `window.end` fires. If the interval
   does not divide the window evenly, the last run is the last tick at or before `end`;
   anything past it rolls to the next allowed day.
4. **Daemon unified.** The "run when app is closed" path will respect the window (and,
   as a side-effect, the `days[]` filter it currently ignores).

## Architecture

`computeNextRunAt(schedule, lastRunAt, now)` in `apps/desktop/src/main/schedule-computation.ts`
is the single source of truth for the next fire time. It is consumed by:

- the in-app scheduler (`apps/desktop/src/main/automation-scheduler.ts`) — active when the
  app is open;
- the daemon (`apps/desktop/src/daemon/daemon.ts`) — active when the app is closed and
  `persistWhenClosed` is set. **Currently the daemon does NOT call `computeNextRunAt`**; it
  recomputes `nextRunAt = now + intervalMinutes` inline (`daemon.ts:809`), ignoring `days[]`.

This design routes the daemon through `computeNextRunAt` so both engines share one
window-aware implementation.

## Changes

### 1. Data model — `apps/desktop/src/shared/types.ts`

Extend the `interval` variant of the `AutomationSchedule` discriminated union with an
optional `window`:

```ts
export type AutomationSchedule =
  | { mode: 'daily'; time: string; days: number[] }
  | { mode: 'interval'; intervalMinutes: number; days: number[]; window?: { start: string; end: string } }
  | { mode: 'cron'; cronExpression: string }
```

- `window.start` / `window.end` are `"HH:MM"` strings (24h), end **inclusive**.
- `window` is optional. Absent ⇒ all-day behavior (unchanged). Existing persisted
  schedules deserialize as-is — **no migration required**.

### 2. Computation — `apps/desktop/src/main/schedule-computation.ts`

Rewrite the `interval` branch:

- **No `window`:** keep current behavior exactly — `lastRunAt + intervalMinutes`,
  skipping disallowed days via the existing `findNextAllowedDay` helper.
- **With `window`:** ignore `lastRunAt` for placement; ticks are anchored to the window
  start. Algorithm for the returned next-run:
  1. For a given day D, the tick set is `start, start+interval, …` while `tick ≤ end`
     (both computed as absolute timestamps on day D).
  2. Return the earliest tick `> now` on an allowed day (`days.includes(isoDay(D))`).
  3. If `now` is past today's last in-window tick, or today is not an allowed day, advance
     to the next allowed day (bounded scan, ~14 days) and return its `window.start`.

  The window-aware result is independent of `lastRunAt`, so it is idempotent and produces
  clean times. Strict `> now` guarantees forward progress and prevents re-firing the same
  tick (`updateScheduleAfterRun` calls `computeNextRunAt(schedule, runTime, runTime)`).

### 3. Validation — `apps/desktop/src/shared/schedule-utils.ts`

In `validateSchedule`, for the interval branch when `window` is present:

- `window.start` and `window.end` must match `^\d{2}:\d{2}$` with valid hour/minute.
- `start < end` (minutes-of-day comparison). Reject equal or midnight-crossing windows —
  keeps the semantics single-day and simple.
- Interval longer than the window length is **allowed** (degenerates to one run/day at
  `start`); not an error.

### 4. UI — `apps/desktop/src/renderer/src/components/AddActionDialog.tsx`

In the interval section (currently `:746`):

- Add an **"Active hours"** `Toggle`. Default off.
- When on, render two `<input type="time">` controls (`windowStart`, `windowEnd`),
  defaulting to `09:00` and `17:00`, styled like the existing `dailyTime` input.
- New component state initialized from `existingAction.schedule.window` (interval mode).
- In the schedule-build (`:281`), include `window: activeHours ? { start: windowStart, end: windowEnd } : undefined`.
- Surface the `validateSchedule` error inline as the dialog already does via `scheduleError`.

### 5. Daemon — `apps/desktop/src/daemon/daemon.ts`

Replace the inline recompute at `:806–814`:

```ts
// before
if (schedule?.mode === 'interval') {
  auto.nextRunAt = now + (schedule.intervalMinutes ?? 60) * 60_000
} else if (schedule?.mode === 'daily') {
  auto.nextRunAt = now + 86400_000
}
auto.lastRunAt = now
```

with a single call to the shared helper:

```ts
auto.lastRunAt = now
if (schedule) auto.nextRunAt = computeNextRunAt(schedule, now, now)
```

- Import `computeNextRunAt` from the shared module. `croner` is bundled into `daemon.js`
  but the cron branch is unreachable in the daemon (cron can't `persistWhenClosed`).
- Side-effect: fixes the pre-existing bug where closed-app interval runs ignored `days[]`.
- The daemon also needs window/day awareness on its **tick gate** only if a tick can land
  on a disallowed time — but since `computeNextRunAt` now only ever returns valid in-window
  times, the existing `if (auto.nextRunAt > now) continue` gate (`daemon.ts:754`) is
  sufficient. No change to `tick()`.

## Out of scope

- Web / remote mirror: automations are configured and displayed only in the desktop app;
  the web client is a terminal mirror. No changes.
- Multiple windows per day, per-day distinct windows, midnight-crossing windows,
  windows for `daily`/`cron`. YAGNI.

## Testing

New file `apps/desktop/src/main/schedule-computation.test.ts` (vitest, colocated like the
other `src/main/*.test.ts`). Pure-function cases for `computeNextRunAt` with a window:

- `now` before today's window on an allowed day ⇒ `window.start` today.
- `now` mid-window on an allowed day ⇒ next anchored tick after `now`.
- `now` exactly on a tick boundary ⇒ next tick (strict `>`).
- end-inclusive: a tick landing exactly on `window.end` fires; the tick after it rolls to
  the next allowed day's `window.start`.
- interval not dividing the window evenly ⇒ last run is the last tick ≤ `end`.
- `now` after today's window, or on a disallowed day ⇒ next allowed day's `window.start`.
- regression: no-`window` interval behaves exactly as before (`lastRunAt + interval`,
  day-filtered).

Plus `validateSchedule` cases: valid window, malformed `HH:MM`, `start >= end`.

## Risk / rollback

Low. The feature is additive and gated by an optional field; all existing schedules and
behavior are untouched when `window` is absent. The only behavior change to existing data
is the daemon now honoring `days[]` for closed-app interval runs — a bug fix. Rollback is
reverting the commit; persisted schedules with a `window` would simply be ignored by the
old interval branch (fall back to all-day), not error.
