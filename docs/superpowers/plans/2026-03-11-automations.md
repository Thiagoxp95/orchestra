# Automations Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scheduled execution ("automations") to Orchestra by extending the existing actions system with optional schedule fields, a scheduler engine, a runs panel, and daemon handoff.

**Architecture:** Automations are actions with an optional `schedule` field. A main-process scheduler ticks every 30s, executes due automations via `child_process.spawn`, streams output to the renderer, and stores run history. Persistent automations hand off to the daemon when the app closes. The UI adds an "Automations" sidebar section and an "Automation Runs" slide-out panel.

**Tech Stack:** Electron, React 19, TypeScript, Zustand, electron-store, croner (cron parsing), child_process.spawn

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/shared/types.ts` | Modify | Add `AutomationSchedule`, `AutomationRun`, extend `CustomAction`, `ElectronAPI` (NOT PersistedData — automation data stored at top-level electron-store keys) |
| `src/shared/action-utils.ts` | Create | Extract `buildActionCommand`, `shellQuote` from app-store |
| `src/shared/schedule-utils.ts` | Create | `formatCountdown`, `validateSchedule`, ISO day helpers (renderer-safe, no croner import) |
| `src/main/schedule-computation.ts` | Create | `computeNextRunAt` (imports croner, main-process only) |
| `src/main/automation-scheduler.ts` | Create | Main scheduler: tick loop, spawn execution, output capture, concurrency guard |
| `src/main/persistence.ts` | Modify | Add `loadAutomationRuns`, `saveAutomationRun`, `loadSchedulerState`, `saveSchedulerState` |
| `src/main/index.ts` | Modify | Wire IPC handlers, init scheduler, handoff on close |
| `src/preload/index.ts` | Modify | Add automation IPC methods and listeners |
| `src/daemon/protocol.ts` | Modify | Add automation request types to `DaemonRequest` |
| `src/daemon/daemon.ts` | Modify | Add automation runner for persistent automations |
| `src/renderer/src/store/app-store.ts` | Modify | Import from shared utils, add automation state & actions |
| `src/renderer/src/components/AddActionDialog.tsx` | Modify | Add schedule section, edit mode |
| `src/renderer/src/components/AutomationRunsPanel.tsx` | Create | Slide-out panel for run history and live output |
| `src/renderer/src/components/Sidebar.tsx` | Modify | Add automations section, countdown badges |
| `src/renderer/src/components/App.tsx` | Modify | Wire automation panel toggle and IPC listeners |
| `src/renderer/src/hooks/useAutomations.ts` | Create | Hook for schedule sync IPC, countdown state |
| `electron.vite.config.ts` | Possibly modify | Exclude `croner` from externalize if needed |

---

## Chunk 1: Data Model & Shared Utilities

### Task 1: Install croner dependency

**Files:**
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Install croner**

```bash
cd apps/desktop && bun add croner
```

- [ ] **Step 2: Add croner to externalizeDepsPlugin exclude list**

In `apps/desktop/electron.vite.config.ts`, croner is ESM-only (like electron-store), so it must be excluded from externalization:

```typescript
plugins: [externalizeDepsPlugin({ exclude: ['electron-store', 'croner'] })],
```

- [ ] **Step 3: Verify it builds**

```bash
cd apps/desktop && bun run build
```
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/package.json bun.lock apps/desktop/electron.vite.config.ts
git commit -m "chore: add croner dependency for cron schedule parsing"
```

---

### Task 2: Extend shared types

**Files:**
- Modify: `apps/desktop/src/shared/types.ts:50-64` (CustomAction)
- Modify: `apps/desktop/src/shared/types.ts:78-89` (PersistedData)
- Modify: `apps/desktop/src/shared/types.ts:144-203` (ElectronAPI)

- [ ] **Step 1: Add AutomationSchedule and AutomationRun types**

Add after line 64 (after `CustomAction`), before `AppSettings`:

```typescript
// Automation schedule — discriminated union by mode
export type AutomationSchedule =
  | { mode: 'daily'; time: string; days: number[] }
  | { mode: 'interval'; intervalMinutes: number; days: number[] }
  | { mode: 'cron'; cronExpression: string }

// Days convention: 1=Mon, 7=Sun (ISO 8601)
// Conversion: isoDay = jsDay === 0 ? 7 : jsDay

export interface AutomationRun {
  id: string
  actionId: string
  workspaceId: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'success' | 'error'
  output: string
  exitCode?: number
  errorMessage?: string
  triggeredBy: 'schedule' | 'manual'
}

export interface AutomationSchedulerEntry {
  nextRunAt: number
  lastRunAt: number
}
```

- [ ] **Step 2: Extend CustomAction with automation fields**

Add to the `CustomAction` interface (after `isDefault?: boolean`):

```typescript
  schedule?: AutomationSchedule
  automationEnabled?: boolean
  persistWhenClosed?: boolean
  automationTargetTreeIndex?: number
```

- [ ] **Step 3: DO NOT extend PersistedData**

`automationRuns` and `automationSchedulerState` are stored as **top-level electron-store keys**, separate from the `data` key that holds `PersistedData`. This prevents the renderer's `saveState` from overwriting scheduler-owned data. The persistence functions in Task 5 access them directly via `store.get('automationRuns')` etc.

- [ ] **Step 4: Extend ElectronAPI**

Add to the `ElectronAPI` interface (after `saveState`):

```typescript
  // Automation
  onAutomationRunResult: (callback: (run: AutomationRun) => void) => () => void
  onAutomationRunOutput: (callback: (data: { actionId: string; chunk: string }) => void) => () => void
  onAutomationScheduleSync: (callback: (data: Record<string, number>) => void) => () => void
  getAutomationRuns: (actionId: string) => Promise<AutomationRun[]>
  runAutomationNow: (workspaceId: string, actionId: string) => Promise<void>
  cancelAutomation: (actionId: string) => Promise<void>
```

- [ ] **Step 5: Verify build**

```bash
cd apps/desktop && bun run build
```
Expected: Build succeeds (new fields are optional, no consumers yet)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shared/types.ts
git commit -m "feat(types): add AutomationSchedule, AutomationRun, and extend CustomAction/PersistedData/ElectronAPI"
```

---

### Task 3: Extract buildActionCommand to shared utils

**Files:**
- Create: `apps/desktop/src/shared/action-utils.ts`
- Modify: `apps/desktop/src/renderer/src/store/app-store.ts:63-87`

- [ ] **Step 1: Create shared action-utils**

Create `apps/desktop/src/shared/action-utils.ts`:

```typescript
import type { CustomAction } from './types'

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildActionCommand(action: CustomAction): string | undefined {
  const actionType = action.actionType ?? 'cli'

  if (actionType === 'claude') {
    const parts = ['claude']
    if (action.printMode) parts.push('-p')
    parts.push('--dangerously-skip-permissions')
    if (action.command) parts.push(shellQuote(action.command))
    return parts.join(' ')
  }

  if (actionType === 'codex') {
    const parts = ['codex']
    if (action.printMode) parts.push('-q')
    parts.push('--full-auto')
    if (action.command) parts.push(shellQuote(action.command))
    return parts.join(' ')
  }

  return action.command || undefined
}
```

- [ ] **Step 2: Update app-store.ts to import from shared**

Replace the local `shellQuote` and `buildActionCommand` functions (lines 63-87) with:

```typescript
import { buildActionCommand } from '../../../shared/action-utils'
```

Remove the local `shellQuote` function (line 63-65) and `buildActionCommand` function (line 67-87).

- [ ] **Step 3: Verify build**

```bash
cd apps/desktop && bun run build
```
Expected: Build succeeds, no behavior change

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/shared/action-utils.ts apps/desktop/src/renderer/src/store/app-store.ts
git commit -m "refactor: extract buildActionCommand and shellQuote to shared/action-utils"
```

---

### Task 4: Create schedule utilities (split: renderer-safe + main-only)

**Files:**
- Create: `apps/desktop/src/shared/schedule-utils.ts` (renderer-safe: no croner import)
- Create: `apps/desktop/src/main/schedule-computation.ts` (main-process only: imports croner)

- [ ] **Step 1: Create shared/schedule-utils.ts (renderer-safe)**

This file must NOT import croner — it's used by the renderer for countdown formatting and basic validation.

```typescript
import type { AutomationSchedule } from './types'

/** Convert JS Date.getDay() (0=Sun) to ISO 8601 (1=Mon, 7=Sun) */
export function jsToIsoDay(jsDay: number): number {
  return jsDay === 0 ? 7 : jsDay
}

/** Validate a schedule. Returns null if valid, error string if invalid.
 *  Note: cron validation is basic (non-empty) — full validation done in main process with croner. */
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
    return null // full validation done in main process
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
```

- [ ] **Step 2: Create main/schedule-computation.ts (main-process only)**

This file imports croner and is only used by the main process scheduler.

```typescript
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
    if (lastRunAt === 0) return now // first run: immediate
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
```

- [ ] **Step 2: Verify build**

```bash
cd apps/desktop && bun run build
```
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/shared/schedule-utils.ts
git commit -m "feat: add schedule computation utilities (computeNextRunAt, validateSchedule, formatCountdown)"
```

---

## Chunk 2: Main Process — Persistence, Scheduler & IPC

### Task 5: Extend persistence for automation data

**Files:**
- Modify: `apps/desktop/src/main/persistence.ts`

- [ ] **Step 1: Add automation persistence functions**

Add to `persistence.ts` after the existing functions:

```typescript
import type { AutomationRun, AutomationSchedulerEntry } from '../shared/types'

const MAX_RUNS_PER_ACTION = 100

export function loadAutomationRuns(actionId: string): AutomationRun[] {
  const all = store.get('automationRuns') as Record<string, AutomationRun[]> | undefined
  return all?.[actionId] ?? []
}

export function loadAllAutomationRuns(): Record<string, AutomationRun[]> {
  return (store.get('automationRuns') as Record<string, AutomationRun[]>) ?? {}
}

export function saveAutomationRun(run: AutomationRun): void {
  const all = loadAllAutomationRuns()
  const runs = all[run.actionId] ?? []
  // Update existing running entry or append
  const existingIdx = runs.findIndex((r) => r.id === run.id)
  if (existingIdx >= 0) {
    runs[existingIdx] = run
  } else {
    runs.push(run)
  }
  // Prune to MAX_RUNS_PER_ACTION
  if (runs.length > MAX_RUNS_PER_ACTION) {
    runs.splice(0, runs.length - MAX_RUNS_PER_ACTION)
  }
  all[run.actionId] = runs
  store.set('automationRuns', all)
}

export function deleteAutomationRuns(actionId: string): void {
  const all = loadAllAutomationRuns()
  delete all[actionId]
  store.set('automationRuns', all)
}

export function loadSchedulerState(): Record<string, AutomationSchedulerEntry> {
  return (store.get('automationSchedulerState') as Record<string, AutomationSchedulerEntry>) ?? {}
}

export function saveSchedulerState(state: Record<string, AutomationSchedulerEntry>): void {
  store.set('automationSchedulerState', state)
}
```

- [ ] **Step 2: Update store defaults to include the new keys**

In the `new (Store as any)({...})` defaults, add:

```typescript
  automationRuns: {},
  automationSchedulerState: {}
```

These go at the top level alongside `data` (not inside `data`).

- [ ] **Step 3: Verify build**

```bash
cd apps/desktop && bun run build
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/persistence.ts
git commit -m "feat(persistence): add automation runs and scheduler state storage"
```

---

### Task 6: Create the automation scheduler

**Files:**
- Create: `apps/desktop/src/main/automation-scheduler.ts`

- [ ] **Step 1: Create the scheduler module**

```typescript
import { spawn, type ChildProcess } from 'node:child_process'
import { BrowserWindow } from 'electron'
import { buildActionCommand } from '../shared/action-utils'
import { computeNextRunAt } from './schedule-computation'
import {
  loadSchedulerState,
  saveSchedulerState,
  saveAutomationRun,
  loadPersistedData,
} from './persistence'
import type {
  CustomAction,
  Workspace,
  AutomationRun,
  AutomationSchedulerEntry,
} from '../shared/types'

const TICK_INTERVAL = 30_000 // 30 seconds
const CLI_TIMEOUT = 30 * 60_000 // 30 minutes
const AGENT_TIMEOUT = 60 * 60_000 // 60 minutes
const MAX_OUTPUT = 1024 * 1024 // 1MB

interface RunningAutomation {
  process: ChildProcess
  run: AutomationRun
  output: string
  timeout: ReturnType<typeof setTimeout>
}

let tickInterval: ReturnType<typeof setInterval> | null = null
let mainWindow: BrowserWindow | null = null
const schedulerState = new Map<string, AutomationSchedulerEntry>()
const runningAutomations = new Map<string, RunningAutomation>()

export function initAutomationScheduler(win: BrowserWindow): void {
  mainWindow = win
  // Load persisted scheduler state
  const persisted = loadSchedulerState()
  for (const [id, entry] of Object.entries(persisted)) {
    schedulerState.set(id, entry)
  }
  // Recompute nextRunAt for all automations
  recomputeAllSchedules()
  // Start tick
  tickInterval = setInterval(tick, TICK_INTERVAL)
  // Initial sync to renderer
  syncToRenderer()
}

export function stopAutomationScheduler(): void {
  if (tickInterval) {
    clearInterval(tickInterval)
    tickInterval = null
  }
  // Kill all running automations
  for (const [, running] of runningAutomations) {
    clearTimeout(running.timeout)
    running.process.kill('SIGTERM')
  }
  runningAutomations.clear()
  // Persist state
  const obj: Record<string, AutomationSchedulerEntry> = {}
  for (const [id, entry] of schedulerState) {
    obj[id] = entry
  }
  saveSchedulerState(obj)
}

/** Get persistent automations for daemon handoff */
export function getPersistentAutomations(): Array<{
  actionId: string
  workspaceId: string
  command: string
  cwd: string
  nextRunAt: number
  schedule: CustomAction['schedule']
  lastRunAt: number
}> {
  const data = loadPersistedData()
  const result: Array<{
    actionId: string
    workspaceId: string
    command: string
    cwd: string
    nextRunAt: number
    schedule: CustomAction['schedule']
    lastRunAt: number
  }> = []

  for (const [wsId, ws] of Object.entries(data.workspaces)) {
    for (const action of ws.customActions) {
      if (!action.schedule || !action.automationEnabled || !action.persistWhenClosed) continue
      if (action.schedule.mode === 'cron') continue // cron not supported in daemon
      const entry = schedulerState.get(action.id)
      const command = buildActionCommand(action)
      if (!command) continue
      const treeIndex = action.automationTargetTreeIndex ?? 0
      const tree = ws.trees[treeIndex] ?? ws.trees[0]
      if (!tree) continue
      result.push({
        actionId: action.id,
        workspaceId: wsId,
        command,
        cwd: tree.rootDir,
        nextRunAt: entry?.nextRunAt ?? Date.now(),
        schedule: action.schedule,
        lastRunAt: entry?.lastRunAt ?? 0,
      })
    }
  }
  return result
}

export function cancelAutomation(actionId: string): void {
  const running = runningAutomations.get(actionId)
  if (running) {
    clearTimeout(running.timeout)
    running.process.kill('SIGTERM')
    running.run.status = 'error'
    running.run.errorMessage = 'Cancelled by user'
    running.run.finishedAt = Date.now()
    running.run.output = running.output
    saveAutomationRun(running.run)
    emitRunResult(running.run)
    runningAutomations.delete(actionId)
  }
}

export function runAutomationNow(workspaceId: string, actionId: string): void {
  const data = loadPersistedData()
  const ws = data.workspaces[workspaceId]
  if (!ws) return
  const action = ws.customActions.find((a) => a.id === actionId)
  if (!action) return
  executeAutomation(ws, action, 'manual')
}

export function getSchedulerSyncData(): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [id, entry] of schedulerState) {
    result[id] = entry.nextRunAt
  }
  return result
}

function recomputeAllSchedules(): void {
  const data = loadPersistedData()
  const now = Date.now()
  for (const ws of Object.values(data.workspaces)) {
    for (const action of ws.customActions) {
      if (!action.schedule || !action.automationEnabled) continue
      const existing = schedulerState.get(action.id)
      const lastRunAt = existing?.lastRunAt ?? 0
      const nextRunAt = computeNextRunAt(action.schedule, lastRunAt, now)
      schedulerState.set(action.id, { nextRunAt, lastRunAt })
    }
  }
}

function tick(): void {
  const data = loadPersistedData()
  const now = Date.now()

  for (const [wsId, ws] of Object.entries(data.workspaces)) {
    for (const action of ws.customActions) {
      if (!action.schedule || !action.automationEnabled) continue
      const entry = schedulerState.get(action.id)
      if (!entry || entry.nextRunAt > now) continue
      if (runningAutomations.has(action.id)) continue // concurrency guard
      executeAutomation(ws, action, 'schedule')
    }
  }

  syncToRenderer()
}

function executeAutomation(
  ws: Workspace,
  action: CustomAction,
  triggeredBy: 'schedule' | 'manual'
): void {
  const treeIndex = action.automationTargetTreeIndex ?? 0
  const tree = ws.trees[treeIndex]

  if (!tree) {
    // Stale worktree target
    const run: AutomationRun = {
      id: crypto.randomUUID(),
      actionId: action.id,
      workspaceId: ws.id,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      status: 'error',
      output: '',
      errorMessage: 'Target worktree no longer exists. Automation has been disabled.',
      triggeredBy,
    }
    saveAutomationRun(run)
    emitRunResult(run)
    // Notify renderer to disable this automation
    mainWindow?.webContents.send('automation-disabled', action.id)
    return
  }

  const command = buildActionCommand(action)
  if (!command) return

  const run: AutomationRun = {
    id: crypto.randomUUID(),
    actionId: action.id,
    workspaceId: ws.id,
    startedAt: Date.now(),
    status: 'running',
    output: '',
    triggeredBy,
  }
  saveAutomationRun(run)
  emitRunResult(run)

  const shell = process.env.SHELL || '/bin/sh'
  const child = spawn(shell, ['-l', '-c', command], {
    cwd: tree.rootDir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  const timeoutMs = (action.actionType === 'claude' || action.actionType === 'codex')
    ? AGENT_TIMEOUT
    : CLI_TIMEOUT

  const timeoutHandle = setTimeout(() => {
    child.kill('SIGTERM')
  }, timeoutMs)

  const onData = (chunk: Buffer) => {
    const text = chunk.toString()
    if (output.length < MAX_OUTPUT) {
      output += text
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT) + '\n[output truncated]'
      }
    }
    // Keep running automation's output in sync for cancel
    running.output = output
    mainWindow?.webContents.send('automation-run-output', {
      actionId: action.id,
      chunk: text,
    })
  }

  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)

  const running: RunningAutomation = { process: child, run, output: '', timeout: timeoutHandle }
  runningAutomations.set(action.id, running)

  child.on('close', (code) => {
    clearTimeout(timeoutHandle)
    runningAutomations.delete(action.id)

    run.finishedAt = Date.now()
    run.output = output
    run.exitCode = code ?? undefined
    // null exit code means killed by signal (timeout, cancel) — treat as error
    run.status = code === 0 ? 'success' : 'error'
    if (run.status === 'error' && !run.errorMessage) {
      run.errorMessage = code === null
        ? 'Process was killed (timeout or signal)'
        : `Process exited with code ${code}`
    }
    saveAutomationRun(run)
    emitRunResult(run)

    // Update scheduler state
    const now = Date.now()
    const entry: AutomationSchedulerEntry = {
      lastRunAt: now,
      nextRunAt: action.schedule
        ? computeNextRunAt(action.schedule, now, now)
        : now + 86400000,
    }
    schedulerState.set(action.id, entry)
    persistSchedulerState()
    syncToRenderer()
  })
}

function emitRunResult(run: AutomationRun): void {
  mainWindow?.webContents.send('automation-run-result', run)
}

function syncToRenderer(): void {
  mainWindow?.webContents.send('automation-schedule-sync', getSchedulerSyncData())
}

function persistSchedulerState(): void {
  const obj: Record<string, AutomationSchedulerEntry> = {}
  for (const [id, entry] of schedulerState) {
    obj[id] = entry
  }
  saveSchedulerState(obj)
}
```

- [ ] **Step 2: Verify build**

```bash
cd apps/desktop && bun run build
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/automation-scheduler.ts
git commit -m "feat: add main-process automation scheduler with execution, concurrency guard, and timeout"
```

---

### Task 7: Wire IPC handlers in main process

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Add imports**

Add to the imports at the top of `index.ts`:

```typescript
import {
  initAutomationScheduler,
  stopAutomationScheduler,
  runAutomationNow,
  cancelAutomation,
  getPersistentAutomations,
} from './automation-scheduler'
import { loadAutomationRuns } from './persistence'
```

- [ ] **Step 2: Init scheduler in createWindow**

After `initIdleNotifier(mainWindow)` (line 124), add:

```typescript
  initAutomationScheduler(mainWindow)
```

- [ ] **Step 3: Stop scheduler on window close**

Replace the `mainWindow.on('close', ...)` handler (line 126) with a pattern that works with Electron's close event (which doesn't support async handlers):

```typescript
  let isQuitting = false
  mainWindow.on('close', (e) => {
    if (isQuitting) return // allow close on second pass
    e.preventDefault()
    isQuitting = true

    // Hand off persistent automations to daemon (fire-and-forget)
    const persistentAutomations = getPersistentAutomations()
    const handoffPromise = persistentAutomations.length > 0
      ? client.sendRequest({
          type: 'automation-handoff' as any,
          automations: persistentAutomations,
        }).catch(() => {})
      : Promise.resolve()

    handoffPromise.then(() => {
      stopAutomationScheduler()
      stopMonitoring()
      stopAllWatchers()
      stopAllCodexWatchers()
      client.disconnect()
      mainWindow?.destroy()
    })
  })
```

This prevents the window from closing until daemon handoff completes, then destroys it.

- [ ] **Step 4: Add IPC handlers**

Add after the existing `save-state` handler (after line 324):

```typescript
ipcMain.handle('automation-get-runs', (_, actionId: string) => {
  return loadAutomationRuns(actionId)
})

ipcMain.handle('automation-run-now', (_, workspaceId: string, actionId: string) => {
  runAutomationNow(workspaceId, actionId)
})

ipcMain.handle('automation-cancel', (_, actionId: string) => {
  cancelAutomation(actionId)
})
```

- [ ] **Step 5: Verify build**

```bash
cd apps/desktop && bun run build
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat: wire automation IPC handlers and scheduler lifecycle in main process"
```

---

### Task 8: Extend preload bridge

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`

- [ ] **Step 1: Add automation imports**

Add `AutomationRun` to the type imports:

```typescript
import type {
  // ...existing imports...
  AutomationRun,
} from '../shared/types'
```

- [ ] **Step 2: Add automation methods to the api object**

Add after the last method `getPromptHistory` (after line 189), before the closing `}` of the api object:

```typescript
  onAutomationRunResult: (callback: (run: AutomationRun) => void) => {
    const handler = (_event: any, run: AutomationRun) => callback(run)
    ipcRenderer.on('automation-run-result', handler)
    return () => { ipcRenderer.removeListener('automation-run-result', handler) }
  },
  onAutomationRunOutput: (callback: (data: { actionId: string; chunk: string }) => void) => {
    const handler = (_event: any, data: { actionId: string; chunk: string }) => callback(data)
    ipcRenderer.on('automation-run-output', handler)
    return () => { ipcRenderer.removeListener('automation-run-output', handler) }
  },
  onAutomationScheduleSync: (callback: (data: Record<string, number>) => void) => {
    const handler = (_event: any, data: Record<string, number>) => callback(data)
    ipcRenderer.on('automation-schedule-sync', handler)
    return () => { ipcRenderer.removeListener('automation-schedule-sync', handler) }
  },
  getAutomationRuns: (actionId: string) => {
    return ipcRenderer.invoke('automation-get-runs', actionId)
  },
  runAutomationNow: (workspaceId: string, actionId: string) => {
    return ipcRenderer.invoke('automation-run-now', workspaceId, actionId)
  },
  cancelAutomation: (actionId: string) => {
    return ipcRenderer.invoke('automation-cancel', actionId)
  },
```

- [ ] **Step 3: Update removeAllListeners**

Add to `removeAllListeners` (after line 137):

```typescript
    ipcRenderer.removeAllListeners('automation-run-result')
    ipcRenderer.removeAllListeners('automation-run-output')
    ipcRenderer.removeAllListeners('automation-schedule-sync')
    ipcRenderer.removeAllListeners('automation-disabled')
```

- [ ] **Step 4: Verify build**

```bash
cd apps/desktop && bun run build
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/preload/index.ts
git commit -m "feat: add automation IPC methods and listeners to preload bridge"
```

---

## Chunk 3: Renderer — Store, Hook & Dialog

### Task 9: Add automation state to the Zustand store

**Files:**
- Modify: `apps/desktop/src/renderer/src/store/app-store.ts`

- [ ] **Step 1: Add automation state fields to AppState interface**

Add to the `AppState` interface (after `deletingWorktrees`):

```typescript
  automationNextRunAt: Record<string, number>  // actionId → nextRunAt timestamp
  showAutomationRunsPanel: boolean
  automationRunsPanelActionId: string | null

  setAutomationNextRunAt: (data: Record<string, number>) => void
  openAutomationRunsPanel: (actionId: string) => void
  closeAutomationRunsPanel: () => void
```

- [ ] **Step 2: Add initial values and implementations**

Add to the store creation (in `create<AppState>((set, get) => ({`)):

```typescript
  automationNextRunAt: {},
  showAutomationRunsPanel: false,
  automationRunsPanelActionId: null,

  setAutomationNextRunAt: (data) => set({ automationNextRunAt: data }),
  openAutomationRunsPanel: (actionId) => set({
    showAutomationRunsPanel: true,
    automationRunsPanelActionId: actionId,
  }),
  closeAutomationRunsPanel: () => set({
    showAutomationRunsPanel: false,
    automationRunsPanelActionId: null,
  }),
```

- [ ] **Step 3: Update deleteCustomAction to clean up automation runs**

In `deleteCustomAction`, after removing the action from `customActions`, add a call to clean up runs via IPC. Since the store is in the renderer, this will be handled by a `useEffect` in the component that detects deletions.

(No change needed in store — the cleanup will be triggered from the sidebar or settings when an action is deleted.)

- [ ] **Step 4: Verify build**

```bash
cd apps/desktop && bun run build
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/store/app-store.ts
git commit -m "feat(store): add automation state and panel management to Zustand store"
```

---

### Task 10: Create useAutomations hook

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/useAutomations.ts`

- [ ] **Step 1: Create the hook**

```typescript
import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'

export function useAutomations(): void {
  const setAutomationNextRunAt = useAppStore((s) => s.setAutomationNextRunAt)

  useEffect(() => {
    const unsubSync = window.electronAPI.onAutomationScheduleSync((data) => {
      setAutomationNextRunAt(data)
    })

    return () => {
      unsubSync()
    }
  }, [setAutomationNextRunAt])
}
```

- [ ] **Step 2: Wire hook into App.tsx**

In `apps/desktop/src/renderer/src/App.tsx`, import and call the hook:

```typescript
import { useAutomations } from './hooks/useAutomations'
```

Add inside the `App` component (after `useAgentResponses()`):

```typescript
  useAutomations()
```

- [ ] **Step 3: Verify build**

```bash
cd apps/desktop && bun run build
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/useAutomations.ts apps/desktop/src/renderer/src/App.tsx
git commit -m "feat: add useAutomations hook for schedule sync and wire into App"
```

---

### Task 11: Add schedule section to AddActionDialog

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/AddActionDialog.tsx`

- [ ] **Step 1: Add edit mode and schedule state**

Update the props interface to support edit mode:

```typescript
interface AddActionDialogProps {
  wsColor: string
  existingAction?: CustomAction  // when editing
  worktrees: { rootDir: string; label: string }[]  // for target picker
  onSave: (action: CustomAction) => void
  onCancel: () => void
}
```

Add schedule state variables (after the existing `useState` calls):

```typescript
  const [showSchedule, setShowSchedule] = useState(!!existingAction?.schedule)
  const [scheduleMode, setScheduleMode] = useState<'daily' | 'interval' | 'cron'>(
    existingAction?.schedule?.mode ?? 'interval'
  )
  const [dailyTime, setDailyTime] = useState(
    existingAction?.schedule?.mode === 'daily' ? existingAction.schedule.time : '09:00'
  )
  const [intervalMinutes, setIntervalMinutes] = useState(
    existingAction?.schedule?.mode === 'interval' ? existingAction.schedule.intervalMinutes : 60
  )
  const [cronExpression, setCronExpression] = useState(
    existingAction?.schedule?.mode === 'cron' ? existingAction.schedule.cronExpression : '0 9 * * *'
  )
  const [scheduleDays, setScheduleDays] = useState<number[]>(
    (existingAction?.schedule?.mode === 'daily' || existingAction?.schedule?.mode === 'interval')
      ? existingAction.schedule.days
      : [1, 2, 3, 4, 5, 6, 7]
  )
  const [automationEnabled, setAutomationEnabled] = useState(existingAction?.automationEnabled ?? true)
  const [persistWhenClosed, setPersistWhenClosed] = useState(existingAction?.persistWhenClosed ?? false)
  const [targetTreeIndex, setTargetTreeIndex] = useState(existingAction?.automationTargetTreeIndex ?? 0)
```

Pre-fill existing fields when editing:

```typescript
  // Pre-fill from existingAction
  const [name, setName] = useState(existingAction?.name ?? '')
  const [icon, setIcon] = useState(existingAction?.icon ?? 'PlayIcon')
  const [command, setCommand] = useState(existingAction?.command ?? '')
  const [keybinding, setKeybinding] = useState(existingAction?.keybinding ?? '')
  const [runOnWorktree, setRunOnWorktree] = useState(existingAction?.runOnWorktreeCreation ?? false)
  const [runOnWorktreeDestruction, setRunOnWorktreeDestruction] = useState(existingAction?.runOnWorktreeDestruction ?? false)
  const [singleSession, setSingleSession] = useState(existingAction?.singleSession ?? false)
  const [focusOnCreation, setFocusOnCreation] = useState(existingAction?.focusOnCreation ?? true)
  const [runInBackground, setRunInBackground] = useState(existingAction?.runInBackground ?? false)
  const [actionType, setActionType] = useState<ActionType>(existingAction?.actionType ?? 'cli')
  const [printMode, setPrintMode] = useState(existingAction?.printMode ?? false)
```

- [ ] **Step 2: Add schedule section UI**

Add after the existing toggles section (after `focusOnCreation` toggle, before the save buttons):

```tsx
          {/* Schedule section */}
          <div className="border-t pt-4 mt-2" style={{ borderColor: borderClr }}>
            <button
              type="button"
              onClick={() => setShowSchedule(!showSchedule)}
              className="flex items-center gap-2 text-sm font-medium w-full"
              style={{ color: txt }}
            >
              <svg
                width="12" height="12" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
                style={{ transform: showSchedule ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform 0.15s' }}
              >
                <path d="M6 4l4 4-4 4" />
              </svg>
              Schedule
              {showSchedule && existingAction?.schedule && (
                <span className="ml-auto text-xs opacity-50">Enabled</span>
              )}
            </button>

            {showSchedule && (
              <div className="mt-3 space-y-3">
                {/* Mode toggle */}
                <div className="flex gap-1 rounded-md p-1" style={{ backgroundColor: inputBg }}>
                  {(['daily', 'interval', 'cron'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setScheduleMode(mode)}
                      className="flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors capitalize"
                      style={{
                        backgroundColor: scheduleMode === mode ? `${txt}26` : 'transparent',
                        color: txt,
                        opacity: scheduleMode === mode ? 1 : 0.55,
                      }}
                    >
                      {mode}
                    </button>
                  ))}
                </div>

                {/* Daily: time + days */}
                {scheduleMode === 'daily' && (
                  <>
                    <div>
                      <label className="block text-xs mb-1 opacity-70" style={{ color: txt }}>Time</label>
                      <input
                        type="time"
                        value={dailyTime}
                        onChange={(e) => setDailyTime(e.target.value)}
                        className={`${inputClass} placeholder:opacity-40`}
                        style={inputStyle}
                      />
                    </div>
                    <DayPicker days={scheduleDays} onChange={setScheduleDays} txt={txt} inputBg={inputBg} />
                  </>
                )}

                {/* Interval: minutes + days */}
                {scheduleMode === 'interval' && (
                  <>
                    <div>
                      <label className="block text-xs mb-1 opacity-70" style={{ color: txt }}>Run every</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          value={intervalMinutes}
                          onChange={(e) => setIntervalMinutes(Math.max(1, parseInt(e.target.value) || 1))}
                          className={`w-20 ${inputClass}`}
                          style={inputStyle}
                        />
                        <span className="text-xs" style={{ color: txt, opacity: 0.7 }}>minutes</span>
                      </div>
                    </div>
                    <DayPicker days={scheduleDays} onChange={setScheduleDays} txt={txt} inputBg={inputBg} />
                  </>
                )}

                {/* Cron: expression */}
                {scheduleMode === 'cron' && (
                  <div>
                    <label className="block text-xs mb-1 opacity-70" style={{ color: txt }}>Cron expression</label>
                    <input
                      type="text"
                      value={cronExpression}
                      onChange={(e) => setCronExpression(e.target.value)}
                      placeholder="0 9 * * 1-5"
                      className={`${inputClass} font-mono placeholder:opacity-40`}
                      style={inputStyle}
                    />
                    <p className="text-[10px] mt-1 opacity-50" style={{ color: txt }}>
                      min hour day month weekday
                    </p>
                  </div>
                )}

                {/* Target worktree */}
                {worktrees.length > 1 && (
                  <div>
                    <label className="block text-xs mb-1 opacity-70" style={{ color: txt }}>Target</label>
                    <select
                      value={targetTreeIndex}
                      onChange={(e) => setTargetTreeIndex(parseInt(e.target.value))}
                      className={`${inputClass}`}
                      style={inputStyle}
                    >
                      {worktrees.map((wt, i) => (
                        <option key={i} value={i}>{wt.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Toggles */}
                <Toggle
                  label="Enabled"
                  value={automationEnabled}
                  onChange={setAutomationEnabled}
                  txt={txt} mutedTxt={txt} bg={toggleBg}
                />
                <Toggle
                  label="Run when app is closed"
                  value={persistWhenClosed}
                  onChange={setPersistWhenClosed}
                  txt={txt} mutedTxt={txt} bg={toggleBg}
                  disabled={scheduleMode === 'cron'}
                />
                {scheduleMode === 'cron' && persistWhenClosed && (
                  <p className="text-[10px] opacity-50" style={{ color: txt }}>
                    Cron automations cannot run when the app is closed.
                  </p>
                )}
              </div>
            )}
          </div>
```

- [ ] **Step 3: Create DayPicker inline component**

Add before the `AddActionDialog` function:

```tsx
function DayPicker({ days, onChange, txt, inputBg }: {
  days: number[]; onChange: (days: number[]) => void; txt: string; inputBg: string
}) {
  const labels = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
  return (
    <div>
      <label className="block text-xs mb-1 opacity-70" style={{ color: txt }}>Days</label>
      <div className="flex gap-1.5">
        {labels.map((label, i) => {
          const day = i + 1 // ISO: 1=Mon
          const active = days.includes(day)
          return (
            <button
              key={day}
              type="button"
              onClick={() => {
                if (active) onChange(days.filter((d) => d !== day))
                else onChange([...days, day].sort())
              }}
              className="w-8 h-8 rounded-full text-[10px] font-medium transition-colors"
              style={{
                backgroundColor: active ? txt : inputBg,
                color: active ? inputBg : txt,
                opacity: active ? 1 : 0.5,
              }}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Update handleSave to include schedule fields**

Update the `handleSave` function to build the schedule:

```typescript
Import validateSchedule at the top of the file:

```typescript
import { validateSchedule } from '../../../shared/schedule-utils'
```

Then update handleSave:

```typescript
  const [scheduleError, setScheduleError] = useState<string | null>(null)
```

```typescript
  const handleSave = () => {
    if (!name.trim() || !command.trim()) return

    let schedule: CustomAction['schedule'] = undefined
    if (showSchedule) {
      if (scheduleMode === 'daily') {
        schedule = { mode: 'daily', time: dailyTime, days: scheduleDays }
      } else if (scheduleMode === 'interval') {
        schedule = { mode: 'interval', intervalMinutes, days: scheduleDays }
      } else if (scheduleMode === 'cron') {
        schedule = { mode: 'cron', cronExpression }
      }
      if (schedule) {
        const error = validateSchedule(schedule)
        if (error) { setScheduleError(error); return }
      }
    }
    setScheduleError(null)

    onSave({
      id: existingAction?.id ?? crypto.randomUUID(),
      name: name.trim(),
      icon,
      command: command.trim(),
      keybinding,
      actionType,
      runOnWorktreeCreation: runOnWorktree,
      runOnWorktreeDestruction,
      singleSession: runInBackground ? false : singleSession,
      focusOnCreation: runInBackground ? false : focusOnCreation,
      runInBackground,
      printMode: (actionType === 'claude' || actionType === 'codex') ? printMode : undefined,
      schedule,
      automationEnabled: showSchedule ? automationEnabled : undefined,
      persistWhenClosed: showSchedule ? (scheduleMode === 'cron' ? false : persistWhenClosed) : undefined,
      automationTargetTreeIndex: showSchedule ? targetTreeIndex : undefined,
    })
  }
```

- [ ] **Step 5: Update dialog title and save button text**

Change the title to reflect edit mode:

```tsx
<h2 className="text-lg font-semibold" style={{ color: txt }}>
  {existingAction ? 'Edit Action' : 'Add Action'}
</h2>
```

Save button:

```tsx
{existingAction ? 'Save changes' : 'Save action'}
```

- [ ] **Step 6: Verify build**

```bash
cd apps/desktop && bun run build
```

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/AddActionDialog.tsx
git commit -m "feat(dialog): add schedule section and edit mode to AddActionDialog"
```

---

## Chunk 4: Renderer — Sidebar Automations & Runs Panel

### Task 12: Add automations section to Sidebar

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Get automation state from store**

Add to the existing destructured selectors in the Sidebar component:

```typescript
  const automationNextRunAt = useAppStore((s) => s.automationNextRunAt)
  const openAutomationRunsPanel = useAppStore((s) => s.openAutomationRunsPanel)
```

- [ ] **Step 2: Compute automation actions**

Add a derived value:

```typescript
  const automationActions = customActions.filter((a) => a.schedule && a.automationEnabled !== false)
```

- [ ] **Step 3: Add automations section in the sidebar**

Add a new section after the sessions list (after the `</div>` at line 925, before the `{/* Ports */}` section):

```tsx
      {/* Automations */}
      {automationActions.length > 0 && !collapsed && (
        <div className="px-3 py-2 shrink-0 border-t" style={{ borderColor }}>
          <span className="text-[10px] font-medium" style={{ color: txtColor, opacity: 0.7 }}>
            Automations
          </span>
          <div className="mt-1 space-y-0.5">
            {automationActions.map((action) => {
              const nextRun = automationNextRunAt[action.id]
              const countdown = nextRun ? formatCountdown(nextRun) : null
              const hoverBg = isLightColor(wsColor) ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)'
              return (
                <div
                  key={action.id}
                  className="flex items-center gap-2 px-1.5 py-1 rounded-md cursor-pointer transition-colors"
                  onClick={() => openAutomationRunsPanel(action.id)}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = hoverBg }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '' }}
                >
                  <DynamicIcon name={action.icon} size={14} color={txtColor} />
                  <span className="text-[11px] flex-1 truncate" style={{ color: txtColor }}>
                    {action.name}
                  </span>
                  {countdown && (
                    <span className="text-[10px] font-mono shrink-0" style={{ color: txtColor, opacity: 0.4 }}>
                      {countdown}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
```

- [ ] **Step 4b: Add context menu to automation items**

Add a right-click handler to each automation item:

```tsx
onContextMenu={(e) => {
  e.preventDefault()
  // Show a simple context menu (can use Electron's Menu.popup via IPC or a custom dropdown)
  // For simplicity, use a state-driven dropdown menu:
  setAutomationContextMenu({ actionId: action.id, x: e.clientX, y: e.clientY })
}}
```

Add state and a dropdown menu component for Edit, Run Now, Disable/Enable, Remove Schedule options. The context menu should call `updateCustomAction` for disable/enable and schedule removal, `openAutomationRunsPanel` + `runAutomationNow` for Run Now, and open `AddActionDialog` in edit mode for Edit.

- [ ] **Step 4: Import formatCountdown**

```typescript
import { formatCountdown } from '../../../shared/schedule-utils'
```

- [ ] **Step 5: Add countdown badge to action icons in the footer**

In the footer action buttons section, for each action that has a schedule, show a countdown. Find where the action icons are rendered in collapsed mode or in the footer, and add conditional countdown text. This depends on where actions are rendered — look for `customActions.map` in the sidebar footer area and add:

```tsx
{action.schedule && action.automationEnabled && automationNextRunAt[action.id] && (
  <span className="text-[8px] font-mono" style={{ color: txtColor, opacity: 0.4 }}>
    {formatCountdown(automationNextRunAt[action.id])}
  </span>
)}
```

- [ ] **Step 6: Verify build**

```bash
cd apps/desktop && bun run build
```

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/Sidebar.tsx
git commit -m "feat(sidebar): add automations section with countdown display"
```

---

### Task 13: Create AutomationRunsPanel component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/AutomationRunsPanel.tsx`

- [ ] **Step 1: Create the panel component**

```tsx
import { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'
import { textColor, isLightColor } from '../utils/color'
import { darkenColor } from './TerminalArea'
import type { AutomationRun } from '../../../shared/types'

function StatusBadge({ status, txtColor }: { status: AutomationRun['status']; txtColor: string }) {
  const colors = {
    running: '#3b82f6',
    success: '#3fb950',
    error: '#f85149',
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
      style={{ backgroundColor: `${colors[status]}20`, color: colors[status] }}
    >
      {status === 'running' && (
        <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: colors[status] }} />
      )}
      {status}
    </span>
  )
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return 'just now'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDuration(start: number, end?: number): string {
  const duration = (end ?? Date.now()) - start
  const secs = Math.floor(duration / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remainSecs = secs % 60
  if (mins < 60) return `${mins}m ${remainSecs}s`
  const hours = Math.floor(mins / 60)
  return `${hours}h ${mins % 60}m`
}

export function AutomationRunsPanel({ onClose }: { onClose: () => void }) {
  const actionId = useAppStore((s) => s.automationRunsPanelActionId)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const wsColor = activeWorkspace?.color ?? '#2a2a3e'
  const panelBg = darkenColor(wsColor)
  const txtColor = textColor(wsColor)
  const borderColor = isLightColor(wsColor) ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.08)'

  const action = activeWorkspace?.customActions.find((a) => a.id === actionId)
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [filter, setFilter] = useState<'all' | 'success' | 'error'>('all')
  const [expandedRun, setExpandedRun] = useState<string | null>(null)
  const [liveOutput, setLiveOutput] = useState<Record<string, string>>({})
  const liveOutputRef = useRef(liveOutput)
  liveOutputRef.current = liveOutput

  // Load runs
  useEffect(() => {
    if (!actionId) return
    window.electronAPI.getAutomationRuns(actionId).then(setRuns)
  }, [actionId])

  // Listen for new run results
  useEffect(() => {
    const unsubResult = window.electronAPI.onAutomationRunResult((run) => {
      if (run.actionId !== actionId) return
      setRuns((prev) => {
        const idx = prev.findIndex((r) => r.id === run.id)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = run
          return next
        }
        return [run, ...prev].slice(0, 100)
      })
    })

    const unsubOutput = window.electronAPI.onAutomationRunOutput(({ actionId: aid, chunk }) => {
      if (aid !== actionId) return
      setLiveOutput((prev) => ({ ...prev, [aid]: (prev[aid] ?? '') + chunk }))
    })

    return () => {
      unsubResult()
      unsubOutput()
    }
  }, [actionId])

  const filteredRuns = filter === 'all' ? runs : runs.filter((r) => r.status === filter)
  const sortedRuns = [...filteredRuns].sort((a, b) => b.startedAt - a.startedAt)
  const isRunning = runs.some((r) => r.status === 'running')

  if (!action || !actionId) return null

  return (
    <div
      className="w-80 shrink-0 flex flex-col rounded-xl overflow-hidden ml-2"
      style={{ backgroundColor: panelBg }}
    >
      {/* Header */}
      <div className="px-3 py-2.5 shrink-0" style={{ borderBottom: `1px solid ${borderColor}` }}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold truncate" style={{ color: txtColor }}>
            {action.name}
          </span>
          <div className="flex items-center gap-1.5">
            {isRunning ? (
              <button
                onClick={() => window.electronAPI.cancelAutomation(actionId)}
                className="px-2 py-0.5 rounded text-[10px] transition-colors"
                style={{ backgroundColor: '#f8514920', color: '#f85149' }}
              >
                Cancel
              </button>
            ) : (
              <button
                onClick={() => {
                  if (activeWorkspaceId) {
                    window.electronAPI.runAutomationNow(activeWorkspaceId, actionId)
                  }
                }}
                className="px-2 py-0.5 rounded text-[10px] transition-colors"
                style={{ backgroundColor: `${txtColor}15`, color: txtColor }}
              >
                Run Now
              </button>
            )}
            <button
              onClick={onClose}
              className="p-0.5 rounded hover:opacity-80 transition-opacity"
              style={{ color: txtColor, opacity: 0.5 }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="4" y1="4" x2="12" y2="12" />
                <line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Filter */}
        <div className="flex gap-1">
          {(['all', 'success', 'error'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="px-2 py-0.5 rounded text-[10px] capitalize transition-colors"
              style={{
                backgroundColor: filter === f ? `${txtColor}20` : 'transparent',
                color: txtColor,
                opacity: filter === f ? 1 : 0.5,
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Run list */}
      <div className="flex-1 overflow-y-auto py-1">
        {sortedRuns.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs" style={{ color: txtColor, opacity: 0.4 }}>No runs yet</span>
          </div>
        )}
        {sortedRuns.map((run) => {
          const isExpanded = expandedRun === run.id
          const output = run.status === 'running'
            ? (liveOutput[run.actionId] ?? run.output)
            : run.output
          const preview = output.split('\n').slice(0, 3).join('\n')

          return (
            <div
              key={run.id}
              className="px-3 py-2 cursor-pointer transition-colors"
              style={{ borderBottom: `1px solid ${borderColor}` }}
              onClick={() => setExpandedRun(isExpanded ? null : run.id)}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px]" style={{ color: txtColor, opacity: 0.5 }}>
                  {formatRelativeTime(run.startedAt)}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono" style={{ color: txtColor, opacity: 0.4 }}>
                    {formatDuration(run.startedAt, run.finishedAt)}
                  </span>
                  <StatusBadge status={run.status} txtColor={txtColor} />
                </div>
              </div>
              {run.errorMessage && (
                <p className="text-[10px] mb-1" style={{ color: '#f85149' }}>
                  {run.errorMessage}
                </p>
              )}
              <pre
                className="text-[10px] font-mono whitespace-pre-wrap break-all overflow-hidden"
                style={{
                  color: txtColor,
                  opacity: 0.6,
                  maxHeight: isExpanded ? 'none' : '3.6em',
                }}
              >
                {isExpanded ? output : preview}
              </pre>
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

```bash
cd apps/desktop && bun run build
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/AutomationRunsPanel.tsx
git commit -m "feat: add AutomationRunsPanel slide-out component with run history and live output"
```

---

### Task 14: Wire AutomationRunsPanel into App layout

**Files:**
- Modify: `apps/desktop/src/renderer/src/App.tsx`

- [ ] **Step 1: Import the panel**

```typescript
import { AutomationRunsPanel } from './components/AutomationRunsPanel'
```

- [ ] **Step 2: Get panel state from store**

Add selectors:

```typescript
  const showAutomationRunsPanel = useAppStore((s) => s.showAutomationRunsPanel)
  const closeAutomationRunsPanel = useAppStore((s) => s.closeAutomationRunsPanel)
```

- [ ] **Step 3: Render the panel alongside DiffPanel**

In the layout, after `{showDiffPanel && <DiffPanel onClose={toggleDiffPanel} />}` (line 138), add:

```tsx
          {showAutomationRunsPanel && <AutomationRunsPanel onClose={closeAutomationRunsPanel} />}
```

- [ ] **Step 4: Verify build**

```bash
cd apps/desktop && bun run build
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx
git commit -m "feat: wire AutomationRunsPanel into App layout as slide-out panel"
```

---

## Chunk 5: Daemon Handoff & Final Integration

### Task 15: Extend daemon protocol and add automation runner

**Files:**
- Modify: `apps/desktop/src/daemon/protocol.ts:31-35`
- Modify: `apps/desktop/src/daemon/daemon.ts`

- [ ] **Step 1: Extend DaemonRequest type**

In `protocol.ts`, update the `type` union in `DaemonRequest` (line 33):

```typescript
  type: 'hello' | 'createOrAttach' | 'prewarmShell' | 'write' | 'resize' | 'kill' | 'signal' | 'listSessions' | 'detach' | 'getPromptHistory' | 'automation-handoff' | 'automation-sync' | 'automation-reclaim'
```

- [ ] **Step 2: Add automation runner to daemon**

In `daemon.ts`, add a handler for the new request types in the `TerminalHost` class or at the server connection handler level. Add these imports:

```typescript
import { spawn, type ChildProcess } from 'node:child_process'
```

Add after the `TerminalHost` class definition, a simple `AutomationRunner` class:

```typescript
interface DaemonAutomation {
  actionId: string
  workspaceId: string
  command: string
  cwd: string
  nextRunAt: number
  schedule: any
  lastRunAt: number
}

interface DaemonAutomationRun {
  id: string
  actionId: string
  workspaceId: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'success' | 'error'
  output: string
  exitCode?: number
  errorMessage?: string
  triggeredBy: 'schedule'
}

class AutomationRunner {
  private automations: DaemonAutomation[] = []
  private runs: DaemonAutomationRun[] = []
  private running = new Set<string>()
  private ticker: ReturnType<typeof setInterval> | null = null
  private runsPath = DAEMON_DIR + '/automation-runs.json'

  handoff(automations: DaemonAutomation[]): void {
    this.automations = automations
    this.loadRuns()
    if (!this.ticker) {
      this.ticker = setInterval(() => this.tick(), 30_000)
    }
  }

  reclaim(): DaemonAutomationRun[] {
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
    const runs = [...this.runs]
    this.runs = []
    this.automations = []
    this.saveRuns()
    return runs
  }

  sync(): DaemonAutomationRun[] {
    return [...this.runs]
  }

  private tick(): void {
    const now = Date.now()
    for (const auto of this.automations) {
      if (auto.nextRunAt > now) continue
      if (this.running.has(auto.actionId)) continue
      this.execute(auto)
    }
  }

  private execute(auto: DaemonAutomation): void {
    this.running.add(auto.actionId)
    const shell = process.env.SHELL || '/bin/sh'
    const run: DaemonAutomationRun = {
      id: crypto.randomUUID(),
      actionId: auto.actionId,
      workspaceId: auto.workspaceId,
      startedAt: Date.now(),
      status: 'running',
      output: '',
      triggeredBy: 'schedule',
    }

    const child = spawn(shell, ['-l', '-c', auto.command], {
      cwd: auto.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      if (output.length > 1024 * 1024) {
        output = output.slice(0, 1024 * 1024) + '\n[output truncated]'
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    const timeout = setTimeout(() => child.kill('SIGTERM'), 30 * 60_000)

    child.on('close', (code) => {
      clearTimeout(timeout)
      this.running.delete(auto.actionId)
      run.finishedAt = Date.now()
      run.output = output
      run.exitCode = code ?? undefined
      run.status = code === 0 || code === null ? 'success' : 'error'
      this.runs.push(run)
      this.saveRuns()

      // Recompute nextRunAt with simple arithmetic
      const now = Date.now()
      const schedule = auto.schedule
      if (schedule?.mode === 'interval') {
        auto.nextRunAt = now + (schedule.intervalMinutes ?? 60) * 60_000
      } else if (schedule?.mode === 'daily') {
        auto.nextRunAt = now + 86400_000
      }
      auto.lastRunAt = now
    })
  }

  private loadRuns(): void {
    try {
      if (fs.existsSync(this.runsPath)) {
        this.runs = JSON.parse(fs.readFileSync(this.runsPath, 'utf8'))
      }
    } catch { this.runs = [] }
  }

  private saveRuns(): void {
    try {
      fs.writeFileSync(this.runsPath, JSON.stringify(this.runs))
    } catch {}
  }
}
```

- [ ] **Step 3: Instantiate and wire the runner in the server handler**

Create an instance alongside `TerminalHost`:

```typescript
const automationRunner = new AutomationRunner()
```

In the connection handler where `DaemonRequest` messages are processed (the `switch` or `if/else` on `msg.type`), add cases:

```typescript
case 'automation-handoff':
  automationRunner.handoff(msg.automations ?? [])
  sendJson(socket, { id: msg.id, ok: true })
  break
case 'automation-sync':
  sendJson(socket, { id: msg.id, ok: true, runs: automationRunner.sync() })
  break
case 'automation-reclaim':
  const runs = automationRunner.reclaim()
  sendJson(socket, { id: msg.id, ok: true, runs })
  break
```

- [ ] **Step 4: Verify build**

```bash
cd apps/desktop && bun run build
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/daemon/protocol.ts apps/desktop/src/daemon/daemon.ts
git commit -m "feat(daemon): add automation handoff, sync, and reclaim protocol with daemon-side scheduler"
```

---

### Task 16: Wire daemon reclaim/sync on app startup

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/automation-scheduler.ts`

- [ ] **Step 1: Add reclaim logic after daemon connection**

In `createWindow()`, after `await client.connect(mainWindow)` (line 110), add:

```typescript
  // Reclaim automation runs from daemon (if it ran automations while app was closed)
  try {
    const reclaimResult = await client.sendRequest({
      type: 'automation-reclaim' as any,
    })
    if (reclaimResult.ok && reclaimResult.runs?.length > 0) {
      const { saveAutomationRun } = await import('./persistence')
      for (const run of reclaimResult.runs) {
        saveAutomationRun(run)
      }
    }
  } catch {}
```

- [ ] **Step 2: Add run-completion notifications to scheduler**

In `automation-scheduler.ts`, import Notification and add a helper:

```typescript
import { Notification } from 'electron'

function notifyRunComplete(actionName: string, run: AutomationRun): void {
  if (run.status === 'error') {
    new Notification({
      title: `Automation Failed: ${actionName}`,
      body: run.errorMessage || `Exited with code ${run.exitCode}`,
      urgency: 'critical',
    }).show()
  } else {
    new Notification({
      title: `Automation Complete: ${actionName}`,
      body: `Finished in ${Math.round((run.finishedAt! - run.startedAt) / 1000)}s`,
    }).show()
  }
}
```

Call `notifyRunComplete(action.name, run)` in the `child.on('close')` handler after saving the run.

- [ ] **Step 3: Add deleteAutomationRuns to action deletion flow**

In `automation-scheduler.ts`, export a function:

```typescript
export function onActionDeleted(actionId: string): void {
  schedulerState.delete(actionId)
  deleteAutomationRuns(actionId)
  persistSchedulerState()
}
```

In `main/index.ts`, add a new IPC handler:

```typescript
ipcMain.on('automation-action-deleted', (_, actionId: string) => {
  onActionDeleted(actionId)
})
```

In `preload/index.ts`, add to the api:

```typescript
  automationActionDeleted: (actionId: string) => {
    ipcRenderer.send('automation-action-deleted', actionId)
  },
```

In `types.ts` ElectronAPI, add:

```typescript
  automationActionDeleted: (actionId: string) => void
```

Then in the renderer, in `deleteCustomAction` handler (Sidebar or SettingsDialog), call:

```typescript
window.electronAPI.automationActionDeleted(actionId)
```

- [ ] **Step 4: Verify build**

```bash
cd apps/desktop && bun run build
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/main/automation-scheduler.ts apps/desktop/src/preload/index.ts apps/desktop/src/shared/types.ts
git commit -m "feat: wire daemon reclaim on startup, run completion notifications, and action deletion cleanup"
```

---

### Task 17: Update Sidebar to pass worktrees prop to AddActionDialog

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Update AddActionDialog usage**

Find where `AddActionDialog` is rendered in the Sidebar and SettingsDialog. Update the props to include `worktrees`:

```tsx
<AddActionDialog
  wsColor={wsColor}
  worktrees={workspace.trees.map((t, i) => ({
    rootDir: t.rootDir,
    label: i === 0 ? 'Base' : t.rootDir.split('/').pop() ?? `Tree ${i}`,
  }))}
  onSave={handleAddAction}
  onCancel={() => setShowAddAction(false)}
/>
```

Also check `SettingsDialog.tsx` for any `AddActionDialog` usage and update similarly.

- [ ] **Step 2: Verify build**

```bash
cd apps/desktop && bun run build
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/Sidebar.tsx apps/desktop/src/renderer/src/components/SettingsDialog.tsx
git commit -m "feat: pass worktrees prop to AddActionDialog for automation target selection"
```

---

### Task 17: Integration test — manual smoke test

- [ ] **Step 1: Start the dev server**

```bash
cd apps/desktop && bun run dev
```

- [ ] **Step 2: Test creating an automation**

1. Open a workspace
2. Click "Add Action" in settings
3. Fill in name, type CLI, command `echo "hello from automation"`
4. Expand the Schedule section
5. Set mode to Interval, 1 minute, all days
6. Save
7. Verify the automation appears in the sidebar Automations section
8. Verify countdown updates

- [ ] **Step 3: Test automation execution**

1. Wait for the automation to fire (or click "Run Now" from the runs panel)
2. Click the automation in the sidebar to open the runs panel
3. Verify the run appears with output "hello from automation"
4. Verify status shows "success"

- [ ] **Step 4: Test cancel**

1. Create a long-running automation: `sleep 300`
2. Trigger it via "Run Now"
3. Click "Cancel" in the runs panel
4. Verify it shows as error with "Cancelled by user"

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during automation smoke testing"
```

---

### Task 19: Handle stale worktree auto-disable in renderer

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/shared/types.ts`
- Modify: `apps/desktop/src/renderer/src/hooks/useAutomations.ts`

- [ ] **Step 1: Add onAutomationDisabled to preload**

In `types.ts` ElectronAPI, add:

```typescript
  onAutomationDisabled: (callback: (actionId: string) => void) => () => void
```

In `preload/index.ts`, add:

```typescript
  onAutomationDisabled: (callback: (actionId: string) => void) => {
    const handler = (_event: any, actionId: string) => callback(actionId)
    ipcRenderer.on('automation-disabled', handler)
    return () => { ipcRenderer.removeListener('automation-disabled', handler) }
  },
```

Add to `removeAllListeners`:

```typescript
    ipcRenderer.removeAllListeners('automation-disabled')
```

- [ ] **Step 2: Listen in useAutomations hook**

In `useAutomations.ts`, add to the existing `useEffect`:

```typescript
    const unsubDisabled = window.electronAPI.onAutomationDisabled((actionId) => {
      const state = useAppStore.getState()
      for (const [wsId, ws] of Object.entries(state.workspaces)) {
        const action = ws.customActions.find((a) => a.id === actionId)
        if (action) {
          state.updateCustomAction(wsId, actionId, { automationEnabled: false })
          break
        }
      }
    })

    return () => {
      unsubSync()
      unsubDisabled()
    }
```

- [ ] **Step 3: Add native notification in scheduler for stale worktree**

The `Notification` import and call is already in the scheduler from Task 16. The scheduler's stale worktree handler already sends `automation-disabled` via IPC (from Task 6). Just ensure the notification is also sent:

```typescript
import { Notification } from 'electron'

// In stale worktree handler (executeAutomation):
new Notification({
  title: 'Automation Disabled',
  body: `"${action.name}" was disabled because its target worktree no longer exists.`,
}).show()
```

- [ ] **Step 4: Verify build**

```bash
cd apps/desktop && bun run build
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/preload/index.ts apps/desktop/src/shared/types.ts apps/desktop/src/renderer/src/hooks/useAutomations.ts apps/desktop/src/main/automation-scheduler.ts
git commit -m "feat: handle automation-disabled event in renderer with native notification"
```
