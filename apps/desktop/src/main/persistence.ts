// src/main/persistence.ts
import Store from 'electron-store'
import type {
  PersistedData,
  Workspace,
  TerminalSession,
  AppSettings,
  AutomationRun,
  AutomationSchedulerEntry,
  UsageBackgroundSyncSettings,
} from '../shared/types'

// electron-store v11 is ESM-only; its types don't resolve under moduleResolution:"node"
// but electron-vite bundles it correctly at build time
const isDev = process.env.NODE_ENV === 'development' || !!process.env.ELECTRON_IS_DEV

function safeSave(key: string, value: any): void {
  try {
    store.set(key, value)
  } catch (err: any) {
    if (err?.code === 'ENOSPC') {
      console.error(`[persistence] Disk full, skipping save for "${key}"`)
    } else {
      throw err
    }
  }
}

const store = new (Store as any)({
  name: isDev ? 'orchestra-data-dev' : 'orchestra-data',
  defaults: {
    data: {
      workspaces: {},
      sessions: {},
      activeWorkspaceId: null,
      activeSessionId: null,
      settings: { worktreesDir: '' },
      claudeLastResponse: {},
      codexLastResponse: {}
    },
    automationRuns: {},
    automationSchedulerState: {}
  }
}) as { get(key: string): any; set(key: string, value: any): void }

export function loadPersistedData(): PersistedData {
  return store.get('data')
}

export function savePersistedData(data: PersistedData): void {
  safeSave('data', data)
}

export function saveWorkspaces(
  workspaces: Record<string, Workspace>,
  sessions: Record<string, TerminalSession>,
  activeWorkspaceId: string | null,
  activeSessionId: string | null,
  settings?: AppSettings,
  claudeLastResponse?: Record<string, string>,
  codexLastResponse?: Record<string, string>
): void {
  const current = loadPersistedData()
  const mergedSessions: PersistedData['sessions'] = {}
  const mergedClaudeLastResponse: PersistedData['claudeLastResponse'] = {}
  const mergedCodexLastResponse: PersistedData['codexLastResponse'] = {}
  for (const [id, session] of Object.entries(sessions)) {
    mergedSessions[id] = {
      ...session,
      scrollback: current.sessions[id]?.scrollback ?? '',
      env: current.sessions[id]?.env ?? {}
    }
    mergedClaudeLastResponse[id] = claudeLastResponse?.[id] ?? current.claudeLastResponse?.[id] ?? ''
    mergedCodexLastResponse[id] = codexLastResponse?.[id] ?? current.codexLastResponse?.[id] ?? ''
  }
  safeSave('data', {
    workspaces,
    sessions: mergedSessions,
    activeWorkspaceId,
    activeSessionId,
    settings: settings ?? current.settings ?? { worktreesDir: '' },
    claudeLastResponse: mergedClaudeLastResponse,
    codexLastResponse: mergedCodexLastResponse
  })
}

export function saveSessionScrollback(sessionId: string, scrollback: string, cwd: string): void {
  const data = loadPersistedData()
  if (data.sessions[sessionId]) {
    data.sessions[sessionId].scrollback = scrollback
    data.sessions[sessionId].cwd = cwd
    safeSave('data', data)
  }
}

// Automation persistence — stored at top-level electron-store keys, NOT inside 'data'

const MAX_RUNS_PER_ACTION = 25
const MAX_RUN_OUTPUT_CHARS = 2000

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
  const truncatedRun = run.output.length > MAX_RUN_OUTPUT_CHARS
    ? { ...run, output: '…' + run.output.slice(-MAX_RUN_OUTPUT_CHARS) }
    : run
  const existingIdx = runs.findIndex((r) => r.id === run.id)
  if (existingIdx >= 0) {
    runs[existingIdx] = truncatedRun
  } else {
    runs.push(truncatedRun)
  }
  if (runs.length > MAX_RUNS_PER_ACTION) {
    runs.splice(0, runs.length - MAX_RUNS_PER_ACTION)
  }
  all[run.actionId] = runs
  safeSave('automationRuns', all)
}

export function deleteAutomationRuns(actionId: string): void {
  const all = loadAllAutomationRuns()
  delete all[actionId]
  safeSave('automationRuns', all)
}

export function loadSchedulerState(): Record<string, AutomationSchedulerEntry> {
  return (store.get('automationSchedulerState') as Record<string, AutomationSchedulerEntry>) ?? {}
}

export function saveSchedulerState(state: Record<string, AutomationSchedulerEntry>): void {
  safeSave('automationSchedulerState', state)
}

// Usage background-sync preference — mirrors ClaudeBar's `backgroundSyncEnabled`
// + `backgroundSyncInterval` settings (off by default, 60s when enabled).
export function loadUsageBackgroundSync(): UsageBackgroundSyncSettings | null {
  const raw = store.get('usageBackgroundSync') as UsageBackgroundSyncSettings | undefined
  if (!raw || typeof raw !== 'object') return null
  return {
    enabled: !!raw.enabled,
    intervalSeconds: typeof raw.intervalSeconds === 'number' && raw.intervalSeconds > 0
      ? raw.intervalSeconds
      : 60,
  }
}

export function saveUsageBackgroundSync(settings: UsageBackgroundSyncSettings): void {
  safeSave('usageBackgroundSync', settings)
}
