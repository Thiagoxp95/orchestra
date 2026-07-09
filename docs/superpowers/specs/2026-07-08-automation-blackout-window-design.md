# Automation blackout window (per-automation quiet hours)

**Date:** 2026-07-08
**Status:** Approved, ready for implementation plan

## Problem

Automation schedules (`daily` / `interval` / `cron`) express when an automation *should*
run, but there is no way to say when it must **not** run. The user's use case: *"prevent
automations from running from 5pm to 9am"* — a nightly quiet period that overrides
whatever the schedule says.

The existing interval-only `window` (active hours, 2026-06-26 spec) is the inverse
feature and does not cover this: it only constrains interval mode, and it cannot wrap
midnight.

## Goal

Add an optional per-automation **blackout window** to every schedule mode. Any run the
schedule would place inside the blackout is **skipped entirely** (not deferred); the
automation next fires at whatever its schedule says after the window. The window is
configured with a two-thumb slider over a 00:00–24:00 track; the red region between the
thumbs is the blackout, and it **wraps midnight** when start > end (e.g. `17:00–09:00`).

## Decisions (locked during brainstorming)

1. **Per-automation.** The blackout lives on each automation's schedule, configured in
   the same dialog. No global quiet-hours setting.
2. **Skip, don't defer.** A run landing in the red zone is suppressed; nothing fires at
   the blackout end to "make up" for it. Predictable: runs only ever happen at times the
   schedule itself produces.
3. **Wrap-around supported.** `start > end` means the blackout covers
   `start→23:59` plus `00:00→end`. This is the primary use case (`17:00–09:00`).
   `start === end` is invalid (ambiguous between "never" and "always").
4. **Boundary semantics: start-inclusive, end-exclusive** — `[start, end)`. With
   blackout `17:00–09:00`, a run at exactly `09:00` fires; a run at exactly `17:00` is
   blocked. (Note: the existing active-hours `window` is end-*inclusive*; the two fields
   have different boundary rules and that is intentional — "allowed until 5pm" vs
   "blocked until 9am".)
5. **Applies to all three modes.** Unlike active hours (interval-only), the blackout is
   mode-independent: "I don't care what the schedule is."
6. **Scheduled runs only.** Manual "run now" and webhook-triggered runs ignore the
   blackout — it suppresses scheduled fires exclusively.
7. **Compute-time, not fire-time.** The blackout is enforced inside `computeNextRunAt`
   (Approach A), not by gates in the scheduler/daemon. Both engines already route
   through the shared helper, so they inherit the behavior with **zero engine changes**,
   and the next-run countdown shown in the UI is always a time that will actually fire.

## Architecture

`computeNextRunAt(schedule, lastRunAt, now)` in
`apps/desktop/src/main/schedule-computation.ts` remains the single source of truth.
Verified consumers (no changes needed):

- in-app scheduler — `apps/desktop/src/main/automation-scheduler.ts:203,224,419`
- daemon — `apps/desktop/src/daemon/daemon.ts:812`

Since every returned timestamp is guaranteed outside the blackout, the existing
fire-when-`nextRunAt <= now` gates in both engines need no awareness of the feature.

## Changes

### 1. Data model — `apps/desktop/src/shared/types.ts`

Add one shared optional field across the union:

```ts
export type AutomationSchedule = (
  | { mode: 'daily'; time: string; days: number[] }
  | {
      mode: 'interval'
      intervalMinutes: number
      days: number[]
      window?: { start: string; end: string } // active hours (existing, end-inclusive)
    }
  | { mode: 'cron'; cronExpression: string }
) & {
  blackout?: { start: string; end: string } // "HH:MM"; [start,end) blocked; start>end wraps midnight
}
```

- `blackout` absent ⇒ behavior unchanged. Existing persisted schedules deserialize
  as-is — **no migration required**.

### 2. Computation — `apps/desktop/src/main/schedule-computation.ts`

Restructure without changing the public signature:

- Rename the current body of `computeNextRunAt` to an internal `computeBaseNextRun`
  (per-mode logic, untouched).
- `computeNextRunAt` becomes a skip-loop wrapper:

  1. `candidate = computeBaseNextRun(schedule, lastRunAtEff, nowEff)`.
  2. If `candidate` is outside the blackout ⇒ return it.
  3. Otherwise apply skip semantics: `lastRunAtEff = candidate`,
     `nowEff = candidate` (the strict-`>`/`+interval` progression of the base
     computation makes the next candidate advance), and loop. One base branch does
     not advance: the "run now" bootstrap (`lastRunAt === 0` / overdue clamp) returns
     `now` itself. When a blocked candidate fails to advance, move `nowEff` to the end
     of the blackout occurrence containing it — the first allowed instant — and loop.
  4. Bound the loop to a 14-day scan horizon (matching the existing
     `findNextAllowedDay` bound). If exhausted — i.e. no schedule-produced run exists
     outside the blackout within 14 days — return the first blackout **end** boundary
     after the horizon. This pathological fallback fires at an off-schedule time, but
     never inside the red zone; validation (below) makes it unreachable for statically
     checkable configs.

- In-blackout test (pure helper, exported for tests): convert `candidate` to
  minutes-of-day `m`; blocked iff
  `start < end ? (m >= start && m < end) : (m >= start || m < end)`.
- No-`blackout` schedules take the early return on iteration one — behavior is
  byte-identical to today.

### 3. Validation — `apps/desktop/src/shared/schedule-utils.ts`

In `validateSchedule`, when `blackout` is present (any mode):

- `start`/`end` must be valid `HH:MM` (reuse the existing checker from the interval
  window branch).
- `start !== end` ⇒ error `'Blackout: start and end must differ'`. Any other ordering is
  valid (wrap-around).
- Degenerate configs that could never run are rejected at save time:
  - `daily` mode with `time` inside the blackout ⇒
    `'Daily run time falls inside the blackout window'`.
  - `interval` mode with an active-hours `window` fully contained in the blackout ⇒
    `'Active hours are entirely inside the blackout window'`. ("Fully contained" uses
    the same minutes-of-day math, handling the wrap case.)
  - `cron` cannot be statically checked; the computation fallback (§2.4) covers it.

### 4. UI — `apps/desktop/src/renderer/src/components/AddActionDialog.tsx` + new `BlackoutSlider.tsx`

New component `apps/desktop/src/renderer/src/components/BlackoutSlider.tsx`:

- Custom two-thumb slider (no library; nothing reusable exists in the renderer — the
  only `type="range"` is a single-thumb input in `SettingsDialog.tsx`).
- Horizontal track representing 00:00–24:00 with sparse hour tick labels (0, 6, 12, 18,
  24). Two draggable thumbs snapping to **15-minute** steps (pointer events +
  keyboard arrows for accessibility).
- The region between the thumbs renders **red** (blocked). When `start > end` the red
  fill wraps: `start→right edge` plus `left edge→end`, with the middle segment neutral.
- Selected range displayed as `HH:MM – HH:MM` text above the track.
- Controlled component: `value: { start: string; end: string }`, `onChange`. Styling
  follows the dialog's existing `wsColor`-derived token pattern (`inputBg`,
  `inputBorder`, etc.); red uses the app's existing destructive/danger tone.

In `AddActionDialog.tsx`:

- A **"Blackout window"** `Toggle` below the mode-specific schedule section, visible for
  **all** modes (unlike "Active hours"). Default off.
- State `blackoutEnabled` / `blackout` initialized from
  `existingAction?.schedule?.blackout`; the slider defaults to `17:00 – 09:00` when
  first enabled.
- Schedule build in `handleSave` (`:289`): attach
  `blackout: blackoutEnabled ? blackout : undefined` to whichever mode object is
  constructed.
- Validation errors surface through the existing `scheduleError` inline display.

### 5. Engines — no changes

`automation-scheduler.ts` and `daemon.ts` are untouched (see Architecture).

## Out of scope

- Web / remote mirror: schedule config is desktop-only; the web client never renders it.
- Global (all-automations) quiet hours.
- Multiple blackout ranges per day, per-day distinct blackouts.
- Blocking manual "run now" or webhook triggers.

## Testing

`apps/desktop/src/main/schedule-computation.test.ts` (extend existing file):

- Non-wrap blackout (`13:00–15:00`): interval ticks inside the range are skipped; the
  first schedule-produced tick after the blackout fires. (A daily time inside the
  blackout is a validation reject — a fixed daily time is either always blocked or
  never blocked, so a *valid* daily schedule is never affected at computation time.)
- Wrap blackout (`17:00–09:00`): interval automation effectively runs 09:00–16:59
  daily; daily-at-12:00 unaffected.
- Boundaries: candidate exactly at `end` fires; exactly at `start` is blocked.
- Cron: candidate inside blackout advances to the next cron occurrence outside it.
- Skip-not-defer: with interval-30min and blackout `13:00–15:00`, a blocked 13:10 tick
  resumes at the schedule-produced `15:10`, not at the blackout end `15:00`.
- Bootstrap: `lastRunAt === 0` ("run now") landing inside the blackout resumes at the
  blackout end — the one case that fires at the end boundary by design.
- Pathological fallback: cron firing only at 03:00 with blackout `17:00–09:00` returns
  a blackout-end boundary after the 14-day horizon, never an in-blackout time.
- Regression: schedules without `blackout` produce identical results to today across
  all three modes, including the active-hours window paths.

`apps/desktop/src/shared/schedule-utils.test.ts` (extend): valid wrap and non-wrap
blackouts, malformed `HH:MM`, `start === end`, daily-time-inside-blackout, active-hours
window swallowed by blackout (wrap and non-wrap containment).

Slider component: covered by typecheck + manual QA in the dialog (consistent with the
existing dialog controls, which have no component tests).

## Risk / rollback

Low. Additive optional field; all existing schedules behave identically when `blackout`
is absent. Rollback is reverting the commit — persisted schedules carrying a `blackout`
would be silently ignored by the old computation (treated as no blackout), not error.

## Engine safety rechecks (post-review amendment)

The final review found two gaps the "zero engine changes" design (§5) didn't cover, so
both engines now carry small guards, superseding that section:

- **Edit staleness** (`automation-scheduler.ts` `tick()`): a schedule edit (e.g. adding
  a blackout) doesn't retroactively invalidate an already-cached `nextRunAt`. `tick()`
  now compares the schedule it last computed `nextRunAt` from against the currently
  persisted schedule and recomputes via `computeNextRunAt` on change.
- **Suspend/wake overdue fires** (both engines): a due automation executes at
  wall-clock `now`, which can have drifted into the blackout by the time the fire gate
  runs (e.g. the Mac slept past `nextRunAt` and woke inside the window). Both fire
  gates now recheck `isBlackedOut(now, blackout)` immediately before executing and, if
  blocked, recompute `nextRunAt` instead of running — preserving skip-not-defer.
