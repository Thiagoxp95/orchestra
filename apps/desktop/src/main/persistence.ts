// src/main/persistence.ts
import Store from 'electron-store'
import type { PersistedData, Workspace, TerminalSession, AppSettings } from '../shared/types'

// electron-store v11 is ESM-only; its types don't resolve under moduleResolution:"node"
// but electron-vite bundles it correctly at build time
const isDev = process.env.NODE_ENV === 'development' || !!process.env.ELECTRON_IS_DEV
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
    }
  }
}) as { get(key: string): any; set(key: string, value: any): void }

export function loadPersistedData(): PersistedData {
  return store.get('data')
}

export function savePersistedData(data: PersistedData): void {
  store.set('data', data)
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
  store.set('data', {
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
    store.set('data', data)
  }
}
