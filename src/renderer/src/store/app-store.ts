import { create } from 'zustand'
import type { Workspace, WorkspaceTree, TerminalSession, ProcessStatus, AppSettings, CustomAction } from '../../../shared/types'

function generateId(): string {
  return crypto.randomUUID()
}

/** Get the active tree for a workspace, with a safe fallback */
function activeTree(ws: Workspace): WorkspaceTree {
  return ws.trees[ws.activeTreeIndex] ?? ws.trees[0]
}

export const DEFAULT_ACTIONS: CustomAction[] = [
  {
    id: 'default-claude',
    name: 'Claude',
    icon: '__claude__',
    command: 'claude --dangerously-skip-permissions',
    keybinding: '',
    runOnWorktreeCreation: false,
    isDefault: true
  },
  {
    id: 'default-codex',
    name: 'Codex',
    icon: '__openai__',
    command: 'codex --full-auto',
    keybinding: '',
    runOnWorktreeCreation: false,
    isDefault: true
  },
  {
    id: 'default-terminal',
    name: 'Terminal',
    icon: '__terminal__',
    command: '',
    keybinding: '',
    runOnWorktreeCreation: false,
    isDefault: true
  }
]

interface AppState {
  workspaces: Record<string, Workspace>
  sessions: Record<string, TerminalSession>
  activeWorkspaceId: string | null
  activeSessionId: string | null
  settings: AppSettings

  updateSettings: (settings: AppSettings) => void
  addCustomAction: (workspaceId: string, action: CustomAction) => void
  updateCustomAction: (workspaceId: string, actionId: string, updates: Partial<CustomAction>) => void
  deleteCustomAction: (workspaceId: string, actionId: string) => void
  createWorkspace: (name: string, color: string, rootDir: string) => string
  deleteWorkspace: (id: string) => void
  updateWorkspace: (id: string, updates: Partial<Pick<Workspace, 'name' | 'color'>>) => void
  createSession: (workspaceId: string, initialCommand?: string, actionId?: string, actionIcon?: string) => string
  runAction: (workspaceId: string, action: CustomAction) => string
  deleteSession: (id: string) => void
  setActiveWorkspace: (id: string) => void
  setActiveSession: (id: string) => void
  setProcessStatus: (sessionId: string, status: ProcessStatus) => void
  addWorktree: (workspaceId: string, rootDir: string) => void
  setActiveTree: (workspaceId: string, index: number) => void
  loadPersistedState: (
    workspaces: Record<string, Workspace>,
    sessions: Record<string, TerminalSession>,
    activeWorkspaceId: string | null,
    activeSessionId: string | null,
    settings?: AppSettings
  ) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  workspaces: {},
  sessions: {},
  activeWorkspaceId: null,
  activeSessionId: null,
  settings: { worktreesDir: '' },

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

  createWorkspace: (name, color, rootDir) => {
    const id = generateId()
    const sessionId = generateId()
    const workspace: Workspace = {
      id,
      name,
      color,
      trees: [{ rootDir, sessionIds: [sessionId] }],
      activeTreeIndex: 0,
      customActions: [...DEFAULT_ACTIONS],
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
      for (const tree of workspace.trees) {
        for (const sid of tree.sessionIds) {
          delete newSessions[sid]
        }
      }
      const newWorkspaces = { ...state.workspaces }
      delete newWorkspaces[id]
      const remainingIds = Object.keys(newWorkspaces)
      const fallbackWs = remainingIds[0] ? newWorkspaces[remainingIds[0]] : null
      return {
        workspaces: newWorkspaces,
        sessions: newSessions,
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

  createSession: (workspaceId, initialCommand?, actionId?, actionIcon?) => {
    const state = get()
    const workspace = state.workspaces[workspaceId]
    if (!workspace) return ''
    const tree = activeTree(workspace)
    const sessionId = generateId()
    const sessionCount = tree.sessionIds.length + 1
    const session: TerminalSession = {
      id: sessionId,
      workspaceId,
      label: `Terminal ${sessionCount}`,
      processStatus: 'terminal',
      cwd: tree.rootDir,
      shellPath: '',
      initialCommand,
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

    // Single-session mode: reuse existing session for this action
    if (action.singleSession) {
      const existingSessionId = tree.sessionIds.find(
        (sid) => state.sessions[sid]?.actionId === action.id
      )
      if (existingSessionId) {
        if (shouldFocus) set({ activeSessionId: existingSessionId })
        // Ctrl+C to kill running process, clear screen, then re-run
        window.electronAPI.writeTerminal(existingSessionId, '\x03')
        setTimeout(() => {
          window.electronAPI.writeTerminal(existingSessionId, 'clear\n')
          setTimeout(() => {
            if (action.command) {
              window.electronAPI.writeTerminal(existingSessionId, action.command + '\n')
            }
          }, 50)
        }, 50)
        return existingSessionId
      }
    }

    // Create new session (default behavior, or first run of single-session)
    const sessionId = get().createSession(workspaceId, action.command || undefined, action.singleSession ? action.id : undefined, action.icon)
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
      delete newSessions[id]
      const newTrees = [...workspace.trees]
      newTrees[treeIdx] = { ...tree, sessionIds: newSessionIds }
      const newActiveSessionId =
        state.activeSessionId === id
          ? (newSessionIds[0] ?? null)
          : state.activeSessionId
      return {
        workspaces: {
          ...state.workspaces,
          [session.workspaceId]: { ...workspace, trees: newTrees }
        },
        sessions: newSessions,
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
    if (workspace) {
      const treeIndex = workspace.trees.findIndex((t) => t.sessionIds.includes(id))
      if (treeIndex >= 0 && treeIndex !== workspace.activeTreeIndex) {
        set({
          activeSessionId: id,
          workspaces: {
            ...state.workspaces,
            [workspace.id]: { ...workspace, activeTreeIndex: treeIndex }
          }
        })
        return
      }
    }
    set({ activeSessionId: id })
  },

  setProcessStatus: (sessionId, status) => {
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return state
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, processStatus: status }
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

  loadPersistedState: (workspaces, sessions, activeWorkspaceId, activeSessionId, settings) => {
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
          createdAt: ws.createdAt
        }
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
      }
      migrated[id] = base
    }

    // Migrate old command settings into default actions
    const oldSettings = settings as any
    if (oldSettings?.claudeCommand || oldSettings?.codexCommand) {
      for (const ws of Object.values(migrated)) {
        ws.customActions = ws.customActions.map((a) => {
          if (a.id === 'default-claude' && oldSettings.claudeCommand && a.command === DEFAULT_ACTIONS[0].command) {
            return { ...a, command: oldSettings.claudeCommand }
          }
          if (a.id === 'default-codex' && oldSettings.codexCommand && a.command === DEFAULT_ACTIONS[1].command) {
            return { ...a, command: oldSettings.codexCommand }
          }
          return a
        })
      }
    }

    set({
      workspaces: migrated,
      sessions,
      activeWorkspaceId,
      activeSessionId,
      settings: { worktreesDir: oldSettings?.worktreesDir ?? settings?.worktreesDir ?? '' }
    })
  }
}))

/** Helper for components to get the active tree */
export function getActiveTree(ws: Workspace): WorkspaceTree {
  return activeTree(ws)
}
