import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { BrowserWindow, Notification } from 'electron'
import { buildActionCommand } from '../shared/action-utils'
import { computeNextRunAt } from './schedule-computation'
import {
  loadSchedulerState,
  saveSchedulerState,
  saveAutomationRun,
  deleteAutomationRuns,
  loadPersistedData,
} from './persistence'
import {
  PtyMessageType,
  writeFrame,
  createFrameParser,
  type SpawnMessage,
} from '../daemon/protocol'
import { resolveNodeExecPath, buildShellChildEnv, buildNodeChildEnv } from './node-runtime'
import type {
  CustomAction,
  Workspace,
  AutomationRun,
  AutomationSchedulerEntry,
} from '../shared/types'

const TICK_INTERVAL = 30_000
const CLI_TIMEOUT = 30 * 60_000
const AGENT_TIMEOUT = 60 * 60_000
const MAX_OUTPUT = 1024 * 1024

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
  const persisted = loadSchedulerState()
  for (const [id, entry] of Object.entries(persisted)) {
    schedulerState.set(id, entry)
  }
  recomputeAllSchedules()
  tickInterval = setInterval(tick, TICK_INTERVAL)
  syncToRenderer()
}

export function stopAutomationScheduler(): void {
  if (tickInterval) {
    clearInterval(tickInterval)
    tickInterval = null
  }
  for (const [, running] of runningAutomations) {
    clearTimeout(running.timeout)
    running.process.kill('SIGTERM')
  }
  runningAutomations.clear()
  persistSchedulerState()
}

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
      if (action.schedule.mode === 'cron') continue
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

export function onActionDeleted(actionId: string): void {
  schedulerState.delete(actionId)
  deleteAutomationRuns(actionId)
  persistSchedulerState()
}

export function getSchedulerSyncData(): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [id, entry] of schedulerState) {
    result[id] = entry.nextRunAt
  }
  return result
}

export function getSchedulerDebugState(): {
  schedulerEntries: Record<string, { nextRunAt: number; lastRunAt: number }>
  runningIds: string[]
  tickIntervalActive: boolean
  actionsFound: { actionId: string; name: string; schedule: any; automationEnabled: any; nextRunAt: number; isDue: boolean }[]
} {
  const data = loadPersistedData()
  const now = Date.now()
  const actionsFound: { actionId: string; name: string; schedule: any; automationEnabled: any; nextRunAt: number; isDue: boolean }[] = []

  for (const ws of Object.values(data.workspaces)) {
    for (const action of ws.customActions) {
      if (!action.schedule) continue
      const entry = schedulerState.get(action.id)
      actionsFound.push({
        actionId: action.id,
        name: action.name,
        schedule: action.schedule,
        automationEnabled: action.automationEnabled,
        nextRunAt: entry?.nextRunAt ?? 0,
        isDue: (entry?.nextRunAt ?? Infinity) <= now,
      })
    }
  }

  const entries: Record<string, { nextRunAt: number; lastRunAt: number }> = {}
  for (const [id, entry] of schedulerState) {
    entries[id] = entry
  }

  return {
    schedulerEntries: entries,
    runningIds: [...runningAutomations.keys()],
    tickIntervalActive: tickInterval !== null,
    actionsFound,
  }
}

function recomputeAllSchedules(): void {
  const data = loadPersistedData()
  const now = Date.now()
  let found = 0
  for (const ws of Object.values(data.workspaces)) {
    for (const action of ws.customActions) {
      if (!action.schedule || !action.automationEnabled) {
        if (action.schedule) {
          console.log(`[scheduler] Skipping ${action.name}: automationEnabled=${action.automationEnabled}`)
        }
        continue
      }
      const existing = schedulerState.get(action.id)
      const lastRunAt = existing?.lastRunAt ?? 0
      const nextRunAt = computeNextRunAt(action.schedule, lastRunAt, now)
      schedulerState.set(action.id, { nextRunAt, lastRunAt })
      console.log(`[scheduler] Scheduled ${action.name}: nextRunAt=${new Date(nextRunAt).toISOString()} (in ${Math.round((nextRunAt - now) / 1000)}s)`)
      found++
    }
  }
  console.log(`[scheduler] recomputeAllSchedules: ${found} actions scheduled`)
}

function tick(): void {
  const data = loadPersistedData()
  const now = Date.now()
  console.log(`[scheduler] tick at ${new Date(now).toISOString()}, schedulerState size=${schedulerState.size}`)

  for (const [wsId, ws] of Object.entries(data.workspaces)) {
    void wsId
    for (const action of ws.customActions) {
      if (!action.schedule || !action.automationEnabled) continue
      let entry = schedulerState.get(action.id)
      // Auto-register newly added actions
      if (!entry) {
        const nextRunAt = computeNextRunAt(action.schedule, 0, now)
        entry = { nextRunAt, lastRunAt: 0 }
        schedulerState.set(action.id, entry)
        persistSchedulerState()
        console.log(`[scheduler] Auto-registered ${action.name}: nextRunAt=${new Date(nextRunAt).toISOString()} (in ${Math.round((nextRunAt - now) / 1000)}s)`)
      }
      if (entry.nextRunAt > now) {
        console.log(`[scheduler] ${action.name}: not due yet (in ${Math.round((entry.nextRunAt - now) / 1000)}s)`)
        continue
      }
      if (runningAutomations.has(action.id)) {
        console.log(`[scheduler] ${action.name}: already running, skipping`)
        continue
      }
      console.log(`[scheduler] EXECUTING ${action.name}`)
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
    mainWindow?.webContents.send('automation-disabled', action.id)
    new Notification({
      title: 'Automation Disabled',
      body: `"${action.name}" was disabled because its target worktree no longer exists.`,
    }).show()
    return
  }

  // Force print mode for Claude/Codex — automation runs are unattended
  const actionForCommand = (action.actionType === 'claude' || action.actionType === 'codex')
    ? { ...action, printMode: true }
    : action
  const command = buildActionCommand(actionForCommand)
  if (!command) {
    console.log(`[scheduler] ${action.name}: no command built, skipping`)
    return
  }
  console.log(`[scheduler] Executing ${action.name}: command=${command}, cwd=${tree.rootDir}, triggeredBy=${triggeredBy}`)

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

  // All automations run through pty-subprocess (same as normal terminal
  // sessions) so commands get a real TTY and full shell environment.
  spawnViaPty(action, command, tree.rootDir, run)
}

/** Spawn a command via pty-subprocess to provide a real TTY. */
function spawnViaPty(
  action: CustomAction,
  command: string,
  cwd: string,
  run: AutomationRun,
): void {
  const nodeExecPath = resolveNodeExecPath()
  const subprocessPath = join(__dirname, 'pty-subprocess.js')

  const child = spawn(nodeExecPath, [subprocessPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: buildNodeChildEnv({ ORCHESTRA_NODE_EXEC_PATH: nodeExecPath }),
  })

  let output = ''
  const isAgent = action.actionType === 'claude' || action.actionType === 'codex'
  const timeoutMs = isAgent ? AGENT_TIMEOUT : CLI_TIMEOUT
  const timeoutHandle = setTimeout(() => {
    child.kill('SIGTERM')
  }, timeoutMs)

  const running: RunningAutomation = { process: child, run, output: '', timeout: timeoutHandle }
  runningAutomations.set(action.id, running)

  const parseFrame = createFrameParser((type, payload) => {
    switch (type) {
      case PtyMessageType.Ready: {
        // PTY subprocess is ready — send a spawn message for the shell.
        // Use -i (interactive) so .zshrc/.bashrc are sourced — Claude Code
        // may need env vars (API keys, PATH entries) set there.
        const shell = process.env.SHELL || '/bin/sh'
        const env = buildShellChildEnv({ SHELL: shell }) as Record<string, string>
        const msg: SpawnMessage = {
          file: shell,
          args: ['-i', '-l', '-c', command],
          cwd,
          cols: 120,
          rows: 40,
          env,
        }
        writeFrame(child.stdin!, PtyMessageType.Spawn, Buffer.from(JSON.stringify(msg)))
        break
      }

      case PtyMessageType.Spawned:
        // PTY is running, nothing to do
        break

      case PtyMessageType.Data: {
        const text = payload.toString('utf8')
        if (output.length < MAX_OUTPUT) {
          output += text
          if (output.length > MAX_OUTPUT) {
            output = output.slice(0, MAX_OUTPUT) + '\n[output truncated]'
          }
        }
        running.output = output
        mainWindow?.webContents.send('automation-run-output', {
          actionId: action.id,
          chunk: text,
        })
        break
      }

      case PtyMessageType.Exit: {
        const exitCode = payload.readInt32LE(0)
        clearTimeout(timeoutHandle)
        runningAutomations.delete(action.id)

        run.finishedAt = Date.now()
        run.output = output
        run.exitCode = exitCode === -1 ? undefined : exitCode
        run.status = exitCode === 0 ? 'success' : 'error'
        if (run.status === 'error' && !run.errorMessage) {
          run.errorMessage = `Process exited with code ${exitCode}`
        }
        saveAutomationRun(run)
        emitRunResult(run)
        notifyRunComplete(action.name, run)
        updateScheduleAfterRun(action)
        break
      }

      case PtyMessageType.Error: {
        console.error(`[scheduler] PTY error for ${action.name}: ${payload.toString('utf8')}`)
        break
      }
    }
  })

  child.stdout!.on('data', (chunk: Buffer) => parseFrame(chunk))

  child.on('exit', () => {
    // If exit wasn't handled by PtyMessageType.Exit (unexpected subprocess death)
    if (runningAutomations.has(action.id)) {
      clearTimeout(timeoutHandle)
      runningAutomations.delete(action.id)
      run.finishedAt = Date.now()
      run.output = output
      run.status = 'error'
      run.errorMessage = 'PTY subprocess exited unexpectedly'
      saveAutomationRun(run)
      emitRunResult(run)
      notifyRunComplete(action.name, run)
      updateScheduleAfterRun(action)
    }
  })
}

function updateScheduleAfterRun(action: CustomAction): void {
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
}

function notifyRunComplete(actionName: string, run: AutomationRun): void {
  if (run.status === 'error') {
    new Notification({
      title: `Automation Failed: ${actionName}`,
      body: run.errorMessage || `Exited with code ${run.exitCode}`,
    }).show()
  } else {
    new Notification({
      title: `Automation Complete: ${actionName}`,
      body: `Finished in ${Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000)}s`,
    }).show()
  }
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
