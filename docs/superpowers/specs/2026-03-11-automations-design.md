# Automations Feature Design

## Overview

Add scheduled execution ("automations") to Orchestra by extending the existing actions system. An automation is an action with a schedule attached — no new entity type needed. Automations run on a configurable schedule (daily, interval, or cron), capture output for review, and optionally persist via the daemon when the app is closed.

## Data Model

### Extended `CustomAction` fields

All new fields are optional. An action without `schedule` remains a regular action.

```typescript
// Discriminated union for schedule modes
type AutomationSchedule =
  | { mode: 'daily';    time: string;    days: number[] }           // time: "09:00" (24h)
  | { mode: 'interval'; intervalMinutes: number; days: number[] }   // days filter
  | { mode: 'cron';     cronExpression: string }                    // no days — cron handles it

// Days convention: 1=Mon, 7=Sun (ISO 8601).
// Conversion from JS Date.getDay(): isoDay = jsDay === 0 ? 7 : jsDay

// Added to CustomAction:
interface CustomAction {
  // ... existing fields (id, name, icon, command, actionType, keybinding,
  //     runOnWorktreeCreation, runOnWorktreeDestruction, singleSession,
  //     focusOnCreation, runInBackground, printMode, isDefault) ...

  schedule?: AutomationSchedule
  automationEnabled?: boolean          // toggle on/off without removing schedule
  persistWhenClosed?: boolean          // hand off to daemon when app quits
  automationTargetTreeIndex?: number   // specific worktree index, or undefined = base path (index 0)
}
```

**Validation rules:**
- `time`: must match `HH:MM` 24h format
- `days`: non-empty array, values 1-7
- `intervalMinutes`: positive integer, minimum 1
- `cronExpression`: validated by `croner` library on save

**`nextRunAt` and `lastRunAt` are NOT stored on CustomAction** — both are computed/maintained by the scheduler in the main process, stored in a scheduler-owned map (`Map<string, { nextRunAt: number; lastRunAt: number }>`), persisted via a dedicated persistence path (similar to `saveSessionScrollback`). This avoids race conditions where the renderer's `saveState` could overwrite scheduler-computed values. The scheduler map is pushed to the renderer via IPC.

### AutomationRun (new type)

```typescript
interface AutomationRun {
  id: string
  actionId: string
  workspaceId: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'success' | 'error'
  output: string            // captured stdout/stderr or agent response
  exitCode?: number         // for CLI actions
  errorMessage?: string     // human-readable error context
  triggeredBy: 'schedule' | 'manual'
}
```

Stored in electron-store by extending `PersistedData` with a new `automationRuns: Record<string, AutomationRun[]>` field (keyed by actionId). Pruned to exactly 100 runs per automation on each new run insertion. New persistence functions: `loadAutomationRuns(actionId)`, `saveAutomationRun(run)`, `pruneAutomationRuns(actionId)`.

### Shared utility extraction

`buildActionCommand` and `shellQuote` currently live in the renderer (`app-store.ts`). These must be extracted to `src/shared/action-utils.ts` so both the main process scheduler and the renderer can import them.

### Types and protocol updates

The following existing types/interfaces must be updated:
- `DaemonRequest` in `src/daemon/protocol.ts`: add `'automation-handoff' | 'automation-sync' | 'automation-reclaim'` to the `type` union, with corresponding payload shapes
- `ElectronAPI` in `src/shared/types.ts`: add the new preload methods
- `PersistedData` in `src/shared/types.ts`: add `automationRuns` and `automationSchedulerState` fields
- `removeAllListeners` in `src/preload/index.ts`: add the three new listener channels (`automation-run-result`, `automation-run-output`, `automation-schedule-sync`) to avoid memory leaks

## Execution & Scheduling Engine

### Main process scheduler (`src/main/automation-scheduler.ts`)

- On app start, loads all automations across all workspaces and computes `nextRunAt` for each
- Maintains an in-memory `Map<string, number>` of `actionId → nextRunAt`
- Maintains a `Set<string>` of currently running automation IDs (concurrency guard)
- Runs a single `setInterval` tick every 30 seconds, checking if any automation is due
- When due:
  1. Check concurrency guard — if this automation is already running, **skip** this tick
  2. Add to running set
  3. Resolve the target working directory: use `automationTargetTreeIndex` to find worktree path. If the target worktree no longer exists (deleted since schedule creation), **skip the run, record an error** AutomationRun with message "Target worktree no longer exists", auto-disable the automation (`automationEnabled = false`), and **emit a desktop notification** alerting the user that the automation was disabled due to a missing worktree
  4. Build the command using `buildActionCommand` from `src/shared/action-utils.ts`
  5. Execute using `child_process.spawn` with piped stdout/stderr for live streaming
  6. Stream output chunks to renderer via `automation-run-output` IPC
  7. On completion: create `AutomationRun` record, persist it, emit `automation-run-result`
  8. Update `lastRunAt` on the action (via persistence), recompute `nextRunAt`
  9. Remove from running set
- All action types supported: `cli`, `claude`, `codex`
- **Execution limits**: configurable timeout per automation (default: 30 minutes for CLI, 60 minutes for claude/codex). Output buffer capped at 1MB per run — excess truncated with "[output truncated]" marker.
- **Background actions**: `runInBackground` only affects manual execution (no session created). Automated execution **always** captures output into `AutomationRun` records regardless — the runs panel is the single source of truth for automation output.

### Daemon execution (persistent automations)

When the app closes, persistent automations (`persistWhenClosed: true`) are handed off to the daemon via a new daemon protocol:

**Handoff protocol (app → daemon):**
- New daemon request type: `automation-handoff`
- Payload: array of `{ actionId, workspaceId, command, cwd, nextRunAt, schedule, lastRunAt }`
- Pre-computed command string, resolved cwd, and pre-computed `nextRunAt` — daemon does not need access to workspace data, electron-store, or `croner`. It only performs simple timestamp comparisons against `nextRunAt`.

**Daemon-side execution:**
- Daemon stores the handoff payload in memory
- Runs its own minimal scheduler tick (30s interval, same as main process)
- Compares current time against `nextRunAt` — no cron parsing needed, pure timestamp comparison
- After each execution, recomputes `nextRunAt` using simple arithmetic (interval mode: `now + intervalMinutes * 60000`; daily mode: `now + 24h`; cron mode: not supported in daemon — cron automations cannot be persistent, enforced at creation time)
- Executes due automations via `child_process.spawn`
- Stores `AutomationRun` results in a JSON file at `DAEMON_DIR/automation-runs.json` (keyed by actionId, same structure as electron-store version)

**Sync protocol (daemon → app on reconnect):**
- New daemon request type: `automation-sync`
- Daemon returns all `AutomationRun` records accumulated while app was closed
- Main process merges them into electron-store, emits to renderer
- Daemon clears its local automation-runs.json after successful sync
- Main process resumes ownership of all scheduling

**Daemon takeback (app reopens):**
- New daemon request type: `automation-reclaim`
- Tells daemon to stop its scheduler and discard automation handoff data

### Schedule computation

- **Daily**: next occurrence of `time` on an enabled `day`, skipping past times today. Uses ISO day convention (1=Mon, 7=Sun).
- **Interval**: `lastRunAt + intervalMinutes`, only on enabled `days`. If no `lastRunAt`, first run is immediate.
- **Cron**: evaluated using the `croner` library (ESM-compatible, lightweight). Must be added to `externalizeDepsPlugin` exclude list in `electron.vite.config.ts` if needed.

## Sidebar UI

### Automations section

- New collapsible section below the existing actions section in the sidebar
- Lists all actions that have a `schedule` defined
- Each item displays:
  - Action icon (with type indicator: terminal/claude/codex)
  - Automation name
  - Enable/disable toggle
  - Next run countdown text ("in 5m", "in 2h 30m")
- Click on an item opens the Automation Runs slide-out panel
- Context menu (right-click or "..." button): Edit, Run Now, Disable/Enable, Remove Schedule

### Action icon countdown badges (sidebar footer)

- When an action in the footer has an active schedule (`schedule` defined + `automationEnabled: true`):
  - Small clock/automation indicator overlaid on the action icon
  - Countdown text displayed next to the icon (e.g., "5m", "2h")
  - Tooltip: "Next run in Xh Ym"
- Countdown updates reactively from `automation-schedule-sync` IPC events

### Creating/editing automations

- Extend the existing `AddActionDialog` with a collapsible "Schedule" section
- The dialog supports an **edit mode**: receives an optional `existingAction` prop to pre-populate all fields
- Schedule section contains:
  - Mode toggle: Daily / Interval / Cron
  - **Daily**: time picker (24h), day selector (Mo-Su circles, ISO convention)
  - **Interval**: number input for interval + unit (minutes/hours), day selector
  - **Cron**: text input for cron expression with syntax hint and live validation
  - Persist toggle: "Run when app is closed"
  - Target: base path or specific worktree dropdown
  - Enabled toggle
- Validation: form cannot be submitted with invalid schedule (empty days, bad cron, etc.)
- From an existing action's context menu: "Add Schedule" opens the dialog in edit mode pre-filled

## Automation Runs Panel

### Slide-out panel (similar to existing diff panel)

- Opens when clicking an automation in the sidebar automations section
- **Header**: automation name, status badge (idle/running/last status), "Run Now" button, "Cancel" button (when running), close button
- **Run list**: recent runs in reverse chronological order, each showing:
  - Timestamp (relative: "2 min ago", "yesterday at 09:00")
  - Duration
  - Status badge (success/error/running)
  - Output preview (first 2-3 lines, truncated)
  - Click to expand full output
- **Live output**: currently running automation streams output in real-time
- **Filter**: toggle between All / Success / Error runs
- Max 100 runs displayed per automation

### Notifications

- When a scheduled run completes, emit a desktop notification (reuse existing idle notifier pattern)
- Error runs get a more prominent/urgent notification style
- Respect workspace notification sound settings

## IPC & Preload Bridge

### New IPC channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `automation-run-result` | main → renderer | Run completed, sends `AutomationRun` |
| `automation-run-output` | main → renderer | Live output stream chunk for running automation |
| `automation-get-runs` | renderer → main | Fetch stored runs for an action |
| `automation-run-now` | renderer → main | Manually trigger an automation |
| `automation-cancel` | renderer → main | Cancel a currently running automation |
| `automation-schedule-sync` | main → renderer | Updated `nextRunAt` map for countdown display |

### Preload additions to `window.electronAPI`

```typescript
// Listeners
onAutomationRunResult(callback: (run: AutomationRun) => void): () => void
onAutomationRunOutput(callback: (data: { actionId: string; chunk: string }) => void): () => void
onAutomationScheduleSync(callback: (data: Record<string, number>) => void): () => void  // actionId → nextRunAt

// Invocations
getAutomationRuns(actionId: string): Promise<AutomationRun[]>
runAutomationNow(workspaceId: string, actionId: string): Promise<void>
cancelAutomation(actionId: string): Promise<void>
```

The scheduler emits `automation-schedule-sync` every 30 seconds so the renderer can update countdown displays without computing schedules client-side.

## Persistence

- `AutomationRun` records stored by extending `PersistedData` with `automationRuns: Record<string, AutomationRun[]>` (keyed by actionId)
- New persistence functions added to `src/main/persistence.ts`: `loadAutomationRuns`, `saveAutomationRun`, `pruneAutomationRuns`
- Automation config (schedule, enabled, persist) lives on `CustomAction` in the existing `workspaces` store
- `nextRunAt` and `lastRunAt` are owned by the scheduler, persisted via a dedicated `automationSchedulerState: Record<string, { nextRunAt: number; lastRunAt: number }>` key in electron-store (written by the scheduler only, never by the renderer's `saveState`)
- Pruning: on each new run insertion, if count > 100, remove oldest runs until count = 100
- **Backward compatibility**: all new `CustomAction` fields are optional, so existing persisted data loads without migration. `automationRuns` defaults to `{}` if absent.

## Key Behaviors

1. **Background actions + automation**: `runInBackground` only affects manual execution. Automated runs always capture output into `AutomationRun` records.
2. **Disabled automations**: keep schedule config but skip execution. Countdown not shown.
3. **Deleted actions**: removing an action also removes its automation runs from the store.
4. **App closed + non-persistent**: automations with `persistWhenClosed: false` simply don't run while the app is closed. On reopen, `nextRunAt` is recomputed from current time.
5. **App closed + persistent**: daemon handles execution via handoff protocol, results synced back on app open.
6. **Manual "Run Now"**: creates an `AutomationRun` with `triggeredBy: 'manual'`, same output capture.
7. **Concurrent execution**: if an automation is still running when the next tick fires, the tick is skipped for that automation.
8. **Stale worktree target**: if the targeted worktree has been deleted, the run is skipped with an error recorded.
9. **Timeouts**: CLI automations timeout at 30 minutes, claude/codex at 60 minutes (defaults). Output capped at 1MB per run.
10. **Cancel**: running automations can be canceled from the runs panel, which kills the spawned process.
11. **App quit while running**: on app close, any mid-execution automations are killed. If the automation is persistent, the daemon will re-run it on its next scheduled tick.
12. **Cron + persist restriction**: cron-mode automations cannot have `persistWhenClosed: true` (daemon cannot evaluate cron expressions). Enforced in the UI — persist toggle disabled when cron mode is selected.
