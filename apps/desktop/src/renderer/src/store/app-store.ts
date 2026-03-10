import { create } from 'zustand'
import type {
  Workspace,
  WorkspaceTree,
  TerminalSession,
  ProcessStatus,
  AppSettings,
  CustomAction,
  ClaudeWorkState,
  CodexWorkState,
  TerminalLaunchProfile,
  RepositoryWorkspaceSettings,
} from '../../../shared/types'

function generateId(): string {
  return crypto.randomUUID()
}

/** Get the active tree for a workspace, with a safe fallback */
function activeTree(ws: Workspace): WorkspaceTree {
  return ws.trees[ws.activeTreeIndex] ?? ws.trees[0]
}

export const DEFAULT_ACTIONS: CustomAction[] = [
  {
    id: 'default-terminal',
    name: 'Terminal',
    icon: '__terminal__',
    command: '',
    actionType: 'cli',
    keybinding: 'Cmd+J',
    runOnWorktreeCreation: false,
    isDefault: true
  },
  {
    id: 'default-claude',
    name: 'Claude',
    icon: '__claude__',
    command: '',
    actionType: 'claude',
    keybinding: 'Cmd+N',
    runOnWorktreeCreation: false,
    isDefault: true
  },
  {
    id: 'default-codex',
    name: 'Codex',
    icon: '__openai__',
    command: '',
    actionType: 'codex',
    keybinding: 'Cmd+O',
    runOnWorktreeCreation: false,
    isDefault: true
  }
]

function actionTypeToProcessStatus(actionType?: CustomAction['actionType']): ProcessStatus {
  if (actionType === 'claude') return 'claude'
  if (actionType === 'codex') return 'codex'
  return 'terminal'
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function buildActionCommand(action: CustomAction): string | undefined {
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

function restoreProcessStatus(session: TerminalSession): ProcessStatus {
  if (session.processStatus === 'claude' || session.processStatus === 'codex') {
    return session.processStatus
  }
  return 'terminal'
}

interface AppState {
  workspaces: Record<string, Workspace>
  sessions: Record<string, TerminalSession>
  activeWorkspaceId: string | null
  activeSessionId: string | null
  settings: AppSettings
  showDiffPanel: boolean
  diffSelectedFile: string | null
  sidebarCollapsed: boolean
  claudeLastResponse: Record<string, string>
  claudeWorkState: Record<string, ClaudeWorkState>
  codexLastResponse: Record<string, string>
  codexWorkState: Record<string, CodexWorkState>
  sessionNeedsUserInput: Record<string, boolean>
  deletingWorktrees: Set<string>

  toggleDiffPanel: () => void
  setDiffSelectedFile: (file: string | null) => void
  toggleSidebar: () => void
  updateSettings: (settings: AppSettings) => void
  addCustomAction: (workspaceId: string, action: CustomAction) => void
  updateCustomAction: (workspaceId: string, actionId: string, updates: Partial<CustomAction>) => void
  deleteCustomAction: (workspaceId: string, actionId: string) => void
  createWorkspace: (
    name: string,
    color: string,
    rootDir: string,
    repositorySettings?: RepositoryWorkspaceSettings | null
  ) => string
  deleteWorkspace: (id: string) => void
  updateWorkspace: (
    id: string,
    updates: Partial<Pick<Workspace, 'name' | 'color' | 'notificationSound' | 'questionNotificationSound' | 'repositorySettings'>>
  ) => void
  createSession: (workspaceId: string, initialCommand?: string, actionId?: string, actionIcon?: string, actionName?: string, processStatus?: ProcessStatus, launchProfile?: TerminalLaunchProfile) => string
  runAction: (workspaceId: string, action: CustomAction) => string
  deleteSession: (id: string) => void
  setActiveWorkspace: (id: string) => void
  setActiveSession: (id: string) => void
  setProcessStatus: (sessionId: string, status: ProcessStatus) => void
  setClaudeLastResponse: (sessionId: string, text: string) => void
  setClaudeWorkState: (sessionId: string, state: ClaudeWorkState) => void
  setCodexLastResponse: (sessionId: string, text: string) => void
  setCodexWorkState: (sessionId: string, state: CodexWorkState) => void
  setSessionNeedsUserInput: (sessionId: string, needsUserInput: boolean) => void
  clearSessionNeedsUserInput: (sessionId: string) => void
  updateSessionLabel: (sessionId: string, label: string, icon?: string) => void
  moveSession: (sessionId: string, direction: 'up' | 'down') => void
  addWorktree: (workspaceId: string, rootDir: string) => void
  removeWorktree: (workspaceId: string, treeIndex: number) => void
  setDeletingWorktree: (key: string, deleting: boolean) => void
  setActiveTree: (workspaceId: string, index: number) => void
  loadPersistedState: (
    workspaces: Record<string, Workspace>,
    sessions: Record<string, TerminalSession>,
    activeWorkspaceId: string | null,
    activeSessionId: string | null,
    settings?: AppSettings,
    claudeLastResponse?: Record<string, string>,
    codexLastResponse?: Record<string, string>
  ) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  workspaces: {},
  sessions: {},
  activeWorkspaceId: null,
  activeSessionId: null,
  settings: { worktreesDir: '' },
  showDiffPanel: false,
  diffSelectedFile: null,
  sidebarCollapsed: false,
  claudeLastResponse: {},
  claudeWorkState: {},
  codexLastResponse: {},
  codexWorkState: {},
  sessionNeedsUserInput: {},
  deletingWorktrees: new Set<string>(),

  toggleDiffPanel: () => set((s) => ({ showDiffPanel: !s.showDiffPanel, diffSelectedFile: null })),
  setDiffSelectedFile: (file) => set({ diffSelectedFile: file }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  updateSettings: (settings) => {
    set({ settings })
  },

  addCustomAction: (workspaceId, action) => {
    set((s) => {
      const ws = s.workspaces[workspaceId]
      if (!ws) return s
      return {
        workspaces: {
          ...s.workspaces,
          [workspaceId]: { ...ws, customActions: [...ws.customActions, action] }
        }
      }
    })
  },

  updateCustomAction: (workspaceId, actionId, updates) => {
    set((s) => {
      const ws = s.workspaces[workspaceId]
      if (!ws) return s
      return {
        workspaces: {
          ...s.workspaces,
          [workspaceId]: {
            ...ws,
            customActions: ws.customActions.map((a) => a.id === actionId ? { ...a, ...updates } : a)
          }
        }
      }
    })
  },

  deleteCustomAction: (workspaceId, actionId) => {
    set((s) => {
      const ws = s.workspaces[workspaceId]
      if (!ws) return s
      return {
        workspaces: {
          ...s.workspaces,
          [workspaceId]: {
            ...ws,
            customActions: ws.customActions.filter((a) => a.id !== actionId)
          }
        }
      }
    })
  },

  createWorkspace: (name, color, rootDir, repositorySettings) => {
    const id = generateId()
    const sessionId = generateId()
    const sharedActions = repositorySettings?.customActions?.map((action) => ({ ...action }))
    const workspace: Workspace = {
      id,
      name,
      color: repositorySettings?.color ?? color,
      trees: [{ rootDir, sessionIds: [sessionId] }],
      activeTreeIndex: 0,
      customActions: sharedActions && sharedActions.length > 0 ? sharedActions : [...DEFAULT_ACTIONS],
      repositorySettings: { enabled: Boolean(repositorySettings) },
      createdAt: Date.now()
    }
    const session: TerminalSession = {
      id: sessionId,
      workspaceId: id,
      label: 'Terminal 1',
      processStatus: 'terminal',
      cwd: rootDir,
      shellPath: ''
    }
    set((state) => ({
      workspaces: { ...state.workspaces, [id]: workspace },
      sessions: { ...state.sessions, [sessionId]: session },
      activeWorkspaceId: id,
      activeSessionId: sessionId
    }))
    return id
  },

  deleteWorkspace: (id) => {
    set((state) => {
      const workspace = state.workspaces[id]
      if (!workspace) return state
      const newSessions = { ...state.sessions }
      const newSessionNeedsUserInput = { ...state.sessionNeedsUserInput }
      for (const tree of workspace.trees) {
        for (const sid of tree.sessionIds) {
          delete newSessions[sid]
          delete newSessionNeedsUserInput[sid]
        }
      }
      const newWorkspaces = { ...state.workspaces }
      delete newWorkspaces[id]
      const remainingIds = Object.keys(newWorkspaces)
      const fallbackWs = remainingIds[0] ? newWorkspaces[remainingIds[0]] : null
      return {
        workspaces: newWorkspaces,
        sessions: newSessions,
        sessionNeedsUserInput: newSessionNeedsUserInput,
        activeWorkspaceId:
          state.activeWorkspaceId === id
            ? (remainingIds[0] ?? null)
            : state.activeWorkspaceId,
        activeSessionId:
          state.activeWorkspaceId === id
            ? (fallbackWs ? activeTree(fallbackWs).sessionIds[0] ?? null : null)
            : state.activeSessionId
      }
    })
  },

  updateWorkspace: (id, updates) => {
    set((state) => {
      const workspace = state.workspaces[id]
      if (!workspace) return state
      return {
        workspaces: {
          ...state.workspaces,
          [id]: { ...workspace, ...updates }
        }
      }
    })
  },

  createSession: (workspaceId, initialCommand?, actionId?, actionIcon?, actionName?, processStatus = 'terminal', launchProfile?) => {
    const state = get()
    const workspace = state.workspaces[workspaceId]
    if (!workspace) return ''
    const tree = activeTree(workspace)
    const sessionId = generateId()
    const baseName = actionName || 'Terminal'
    const existingCount = tree.sessionIds.filter((sid) => {
      const s = state.sessions[sid]
      return s && s.label.startsWith(baseName)
    }).length
    const session: TerminalSession = {
      id: sessionId,
      workspaceId,
      label: `${baseName} ${existingCount + 1}`,
      processStatus,
      cwd: tree.rootDir,
      shellPath: '',
      initialCommand,
      launchProfile,
      actionId,
      actionIcon
    }
    const newTrees = [...workspace.trees]
    newTrees[workspace.activeTreeIndex] = {
      ...tree,
      sessionIds: [...tree.sessionIds, sessionId]
    }
    set((s) => ({
      workspaces: {
        ...s.workspaces,
        [workspaceId]: { ...workspace, trees: newTrees }
      },
      sessions: { ...s.sessions, [sessionId]: session },
      activeSessionId: sessionId
    }))
    return sessionId
  },

  runAction: (workspaceId, action) => {
    const state = get()
    const workspace = state.workspaces[workspaceId]
    if (!workspace) return ''
    const tree = activeTree(workspace)
    const shouldFocus = action.focusOnCreation !== false
    const launchProfile: TerminalLaunchProfile | undefined = undefined
    const resolvedCommand = buildActionCommand(action)

    // Single-session mode: reuse existing session for this action
    if (action.singleSession) {
      const existingSessionId = tree.sessionIds.find(
        (sid) => state.sessions[sid]?.actionId === action.id
      )
      if (existingSessionId) {
        if (shouldFocus) set({ activeSessionId: existingSessionId })
        // Ctrl+C to kill running process, clear screen, then re-run
        window.electronAPI.writeTerminal(existingSessionId, '\x03', 'system')
        setTimeout(() => {
          window.electronAPI.writeTerminal(existingSessionId, 'clear\n', 'system')
          setTimeout(() => {
            if (resolvedCommand) {
              window.electronAPI.writeTerminal(existingSessionId, resolvedCommand + '\n', 'system')
            }
          }, 50)
        }, 50)
        return existingSessionId
      }
    }

    // Create new session (default behavior, or first run of single-session)
    const sessionId = get().createSession(
      workspaceId,
      resolvedCommand || undefined,
      action.id,
      action.icon,
      action.name,
      actionTypeToProcessStatus(action.actionType),
      launchProfile,
    )
    if (!shouldFocus && sessionId) {
      // Restore previous active session
      set({ activeSessionId: state.activeSessionId })
    }
    return sessionId
  },

  deleteSession: (id) => {
    set((state) => {
      const session = state.sessions[id]
      if (!session) return state
      const workspace = state.workspaces[session.workspaceId]
      if (!workspace) return state
      const treeIdx = workspace.activeTreeIndex
      const tree = activeTree(workspace)
      const newSessionIds = tree.sessionIds.filter((sid) => sid !== id)
      const newSessions = { ...state.sessions }
      const newSessionNeedsUserInput = { ...state.sessionNeedsUserInput }
      const newClaudeLastResponse = { ...state.claudeLastResponse }
      const newCodexLastResponse = { ...state.codexLastResponse }
      delete newSessions[id]
      delete newSessionNeedsUserInput[id]
      delete newClaudeLastResponse[id]
      delete newCodexLastResponse[id]
      const newTrees = [...workspace.trees]
      newTrees[treeIdx] = { ...tree, sessionIds: newSessionIds }
      let newActiveSessionId = state.activeSessionId
      if (state.activeSessionId === id) {
        const oldIdx = tree.sessionIds.indexOf(id)
        // Prefer the session below, otherwise the one above
        newActiveSessionId = newSessionIds[oldIdx] ?? newSessionIds[oldIdx - 1] ?? null
      }
      return {
        workspaces: {
          ...state.workspaces,
          [session.workspaceId]: { ...workspace, trees: newTrees }
        },
        sessions: newSessions,
        sessionNeedsUserInput: newSessionNeedsUserInput,
        claudeLastResponse: newClaudeLastResponse,
        codexLastResponse: newCodexLastResponse,
        activeSessionId: newActiveSessionId
      }
    })
  },

  setActiveWorkspace: (id) => {
    set((state) => {
      const workspace = state.workspaces[id]
      const tree = workspace ? activeTree(workspace) : null
      return {
        activeWorkspaceId: id,
        activeSessionId: tree?.sessionIds[0] ?? null
      }
    })
  },

  setActiveSession: (id) => {
    const state = get()
    const session = state.sessions[id]
    if (!session) { set({ activeSessionId: id }); return }
    const workspace = state.workspaces[session.workspaceId]
    const updates: Partial<AppState> = { activeSessionId: id }
    // Switch workspace if the session belongs to a different one
    if (session.workspaceId !== state.activeWorkspaceId) {
      updates.activeWorkspaceId = session.workspaceId
    }
    if (workspace) {
      const treeIndex = workspace.trees.findIndex((t) => t.sessionIds.includes(id))
      if (treeIndex >= 0 && treeIndex !== workspace.activeTreeIndex) {
        updates.workspaces = {
          ...state.workspaces,
          [workspace.id]: { ...workspace, activeTreeIndex: treeIndex }
        }
      }
    }
    set(updates)
  },

  setProcessStatus: (sessionId, status) => {
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return state
      const wasAgent = session.processStatus === 'claude' || session.processStatus === 'codex'
      const nowTerminal = status === 'terminal'
      const clearResponse = wasAgent && nowTerminal
      const result: Partial<AppState> = {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, processStatus: status }
        }
      }
      if (clearResponse) {
        const { [sessionId]: _c, ...restClaude } = state.claudeLastResponse
        const { [sessionId]: _x, ...restCodex } = state.codexLastResponse
        result.claudeLastResponse = restClaude
        result.codexLastResponse = restCodex
      }
      return result
    })
  },

  updateSessionLabel: (sessionId, label, icon?) => {
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return state
      const updates: Partial<TerminalSession> = { label }
      if (icon !== undefined) updates.actionIcon = icon
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, ...updates }
        }
      }
    })
  },

  setClaudeLastResponse: (sessionId, text) => {
    set((state) => ({
      claudeLastResponse: { ...state.claudeLastResponse, [sessionId]: text }
    }))
  },

  setClaudeWorkState: (sessionId, state) => {
    set((current) => {
      if (current.claudeWorkState[sessionId] === state) return current
      return { claudeWorkState: { ...current.claudeWorkState, [sessionId]: state } }
    })
  },

  setCodexLastResponse: (sessionId, text) => {
    set((state) => ({
      codexLastResponse: { ...state.codexLastResponse, [sessionId]: text }
    }))
  },

  setCodexWorkState: (sessionId, state) => {
    set((current) => {
      if (current.codexWorkState[sessionId] === state) return current
      return { codexWorkState: { ...current.codexWorkState, [sessionId]: state } }
    })
  },

  setSessionNeedsUserInput: (sessionId, needsUserInput) => {
    set((state) => {
      if (needsUserInput) {
        if (state.sessionNeedsUserInput[sessionId]) return state
        return {
          sessionNeedsUserInput: {
            ...state.sessionNeedsUserInput,
            [sessionId]: true
          }
        }
      }

      if (!(sessionId in state.sessionNeedsUserInput)) return state

      const next = { ...state.sessionNeedsUserInput }
      delete next[sessionId]
      return { sessionNeedsUserInput: next }
    })
  },

  clearSessionNeedsUserInput: (sessionId) => {
    set((state) => {
      if (!(sessionId in state.sessionNeedsUserInput)) return state
      const next = { ...state.sessionNeedsUserInput }
      delete next[sessionId]
      return { sessionNeedsUserInput: next }
    })
  },

  moveSession: (sessionId, direction) => {
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return state
      const workspace = state.workspaces[session.workspaceId]
      if (!workspace) return state
      const treeIdx = workspace.trees.findIndex((t) => t.sessionIds.includes(sessionId))
      if (treeIdx < 0) return state
      const tree = workspace.trees[treeIdx]
      const idx = tree.sessionIds.indexOf(sessionId)
      const newIdx = direction === 'up' ? idx - 1 : idx + 1
      if (newIdx < 0 || newIdx >= tree.sessionIds.length) return state
      const newSessionIds = [...tree.sessionIds]
      newSessionIds[idx] = newSessionIds[newIdx]
      newSessionIds[newIdx] = sessionId
      const newTrees = [...workspace.trees]
      newTrees[treeIdx] = { ...tree, sessionIds: newSessionIds }
      return {
        workspaces: {
          ...state.workspaces,
          [session.workspaceId]: { ...workspace, trees: newTrees }
        }
      }
    })
  },

  addWorktree: (workspaceId, rootDir) => {
    const state = get()
    const workspace = state.workspaces[workspaceId]
    if (!workspace) return
    const sessionId = generateId()
    const newTree: WorkspaceTree = { rootDir, sessionIds: [sessionId] }
    const newTreeIndex = workspace.trees.length
    const session: TerminalSession = {
      id: sessionId,
      workspaceId,
      label: 'Terminal 1',
      processStatus: 'terminal',
      cwd: rootDir,
      shellPath: ''
    }
    set((s) => ({
      workspaces: {
        ...s.workspaces,
        [workspaceId]: {
          ...workspace,
          trees: [...workspace.trees, newTree],
          activeTreeIndex: newTreeIndex
        }
      },
      sessions: { ...s.sessions, [sessionId]: session },
      activeSessionId: sessionId
    }))
  },

  removeWorktree: (workspaceId, treeIndex) => {
    set((state) => {
      const workspace = state.workspaces[workspaceId]
      if (!workspace || treeIndex < 0 || treeIndex >= workspace.trees.length) return state
      if (workspace.trees.length <= 1) return state // Can't remove the last tree

      const tree = workspace.trees[treeIndex]
      const newSessions = { ...state.sessions }
      const newSessionNeedsUserInput = { ...state.sessionNeedsUserInput }
      for (const sid of tree.sessionIds) {
        delete newSessions[sid]
        delete newSessionNeedsUserInput[sid]
      }

      const newTrees = workspace.trees.filter((_, i) => i !== treeIndex)
      const newActiveTreeIndex = workspace.activeTreeIndex >= newTrees.length
        ? newTrees.length - 1
        : workspace.activeTreeIndex > treeIndex
          ? workspace.activeTreeIndex - 1
          : workspace.activeTreeIndex

      const activeTreeAfter = newTrees[newActiveTreeIndex]
      const needNewActiveSession = tree.sessionIds.includes(state.activeSessionId ?? '')

      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: { ...workspace, trees: newTrees, activeTreeIndex: newActiveTreeIndex }
        },
        sessions: newSessions,
        sessionNeedsUserInput: newSessionNeedsUserInput,
        activeSessionId: needNewActiveSession
          ? (activeTreeAfter?.sessionIds[0] ?? null)
          : state.activeSessionId
      }
    })
  },

  setDeletingWorktree: (key, deleting) => {
    set((state) => {
      const next = new Set(state.deletingWorktrees)
      if (deleting) next.add(key)
      else next.delete(key)
      return { deletingWorktrees: next }
    })
  },

  setActiveTree: (workspaceId, index) => {
    set((state) => {
      const workspace = state.workspaces[workspaceId]
      if (!workspace || index < 0 || index >= workspace.trees.length) return state
      const tree = workspace.trees[index]
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: { ...workspace, activeTreeIndex: index }
        },
        activeSessionId: tree.sessionIds[0] ?? null
      }
    })
  },

  loadPersistedState: (workspaces, sessions, activeWorkspaceId, activeSessionId, settings, claudeLastResponse, codexLastResponse) => {
    // Migrate old format: { rootDir, sessionIds } → { trees: [...], activeTreeIndex }
    const migrated: Record<string, Workspace> = {}
    for (const [id, ws] of Object.entries(workspaces)) {
      const raw = ws as any
      let base: Workspace
      if (raw.trees) {
        base = ws
      } else {
        base = {
          id: ws.id,
          name: ws.name,
          color: ws.color,
          trees: [{ rootDir: raw.rootDir, sessionIds: raw.sessionIds ?? [] }],
          activeTreeIndex: 0,
          customActions: [],
          repositorySettings: { enabled: false },
          createdAt: ws.createdAt
        }
      }
      if (!base.repositorySettings) {
        base = { ...base, repositorySettings: { enabled: false } }
      }
      // Ensure customActions exists and has defaults
      if (!base.customActions || base.customActions.length === 0) {
        base = { ...base, customActions: [...DEFAULT_ACTIONS] }
      } else {
        // Ensure default actions are present
        const ids = new Set(base.customActions.map((a) => a.id))
        const missing = DEFAULT_ACTIONS.filter((d) => !ids.has(d.id))
        if (missing.length > 0) {
          base = { ...base, customActions: [...missing, ...base.customActions] }
        }
        // Sync keybindings and migrate old full-command defaults
        const defaultMap = new Map(DEFAULT_ACTIONS.map((d) => [d.id, d]))
        const OLD_FULL_COMMANDS = new Set([
          'claude --dangerously-skip-permissions',
          'codex --full-auto',
        ])
        base = {
          ...base,
          customActions: base.customActions.map((a) => {
            const def = defaultMap.get(a.id)
            if (def && a.isDefault) {
              return {
                ...a,
                keybinding: a.keybinding !== def.keybinding ? def.keybinding : a.keybinding,
                actionType: a.actionType ?? def.actionType,
                // Migrate old defaults that stored the full command as the prompt
                command: OLD_FULL_COMMANDS.has(a.command) ? '' : a.command,
              }
            }
            return a
          })
        }
      }
      migrated[id] = base
    }

    // Migrate old command settings into default actions
    const oldSettings = settings as any
    if (oldSettings?.claudeCommand || oldSettings?.codexCommand) {
      for (const ws of Object.values(migrated)) {
        ws.customActions = ws.customActions.map((a) => {
          if (a.id === 'default-claude' && oldSettings.claudeCommand && a.command === DEFAULT_ACTIONS.find((d) => d.id === 'default-claude')?.command) {
            return { ...a, command: oldSettings.claudeCommand }
          }
          if (a.id === 'default-codex' && oldSettings.codexCommand && a.command === DEFAULT_ACTIONS.find((d) => d.id === 'default-codex')?.command) {
            return { ...a, command: oldSettings.codexCommand }
          }
          return a
        })
      }
    }

    set({
      workspaces: migrated,
      sessions: Object.fromEntries(
        Object.entries(sessions).map(([id, session]) => [id, { ...session, processStatus: restoreProcessStatus(session) }])
      ),
      activeWorkspaceId,
      activeSessionId,
      settings: { worktreesDir: oldSettings?.worktreesDir ?? settings?.worktreesDir ?? '' },
      claudeLastResponse: claudeLastResponse ?? {},
      codexLastResponse: codexLastResponse ?? {},
      sessionNeedsUserInput: {}
    })
  }
}))

/** Helper for components to get the active tree */
export function getActiveTree(ws: Workspace): WorkspaceTree {
  return activeTree(ws)
}
