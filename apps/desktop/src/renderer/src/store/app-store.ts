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
import { buildActionCommand, buildAgentLaunchProfile } from '../../../shared/action-utils'

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


function restoreProcessStatus(session: TerminalSession): ProcessStatus {
  if (session.processStatus === 'claude' || session.processStatus === 'codex') {
    return session.processStatus
  }
  return 'terminal'
}

function findSessionLocation(
  workspaces: Record<string, Workspace>,
  sessionId: string,
): { workspace: Workspace; treeIndex: number; tree: WorkspaceTree } | null {
  for (const workspace of Object.values(workspaces)) {
    const treeIndex = workspace.trees.findIndex((tree) => tree.sessionIds.includes(sessionId))
    if (treeIndex >= 0) {
      return {
        workspace,
        treeIndex,
        tree: workspace.trees[treeIndex],
      }
    }
  }

  return null
}

function findTreeIndexForSession(workspace: Workspace, sessionId: string | null | undefined): number {
  if (!sessionId) return -1
  return workspace.trees.findIndex((tree) => tree.sessionIds.includes(sessionId))
}

function resolveWorkspaceSelection(
  workspace: Workspace,
  preferredSessionId: string | null | undefined = workspace.lastActiveSessionId,
): { treeIndex: number; sessionId: string | null } {
  const preferredTreeIndex = findTreeIndexForSession(workspace, preferredSessionId)
  if (preferredTreeIndex >= 0 && preferredSessionId) {
    return { treeIndex: preferredTreeIndex, sessionId: preferredSessionId }
  }

  const fallbackTreeIndex = workspace.trees[workspace.activeTreeIndex] ? workspace.activeTreeIndex : 0
  const fallbackTree = workspace.trees[fallbackTreeIndex] ?? workspace.trees[0]

  return {
    treeIndex: fallbackTree ? fallbackTreeIndex : 0,
    sessionId: fallbackTree?.sessionIds[0] ?? null,
  }
}

function createRecoveredSession(
  sessionId: string,
  workspaceId: string,
  cwd: string,
  index: number,
): TerminalSession {
  return {
    id: sessionId,
    workspaceId,
    label: `Terminal ${index + 1}`,
    processStatus: 'terminal',
    cwd,
    shellPath: '',
  }
}

function restoreTreeSessions(
  workspaces: Record<string, Workspace>,
  sessions: Record<string, TerminalSession>,
): Record<string, TerminalSession> {
  let nextSessions = sessions

  for (const workspace of Object.values(workspaces)) {
    workspace.trees.forEach((tree) => {
      tree.sessionIds.forEach((sessionId, sessionIndex) => {
        const existingSession = nextSessions[sessionId]
        if (existingSession) {
          if (existingSession.workspaceId !== workspace.id) {
            if (nextSessions === sessions) nextSessions = { ...sessions }
            nextSessions[sessionId] = { ...existingSession, workspaceId: workspace.id, cwd: tree.rootDir }
          }
          return
        }

        if (nextSessions === sessions) nextSessions = { ...sessions }
        nextSessions[sessionId] = createRecoveredSession(
          sessionId,
          workspace.id,
          tree.rootDir,
          sessionIndex,
        )
      })
    })
  }

  return nextSessions
}

function resolveActiveWorkspaceId(
  workspaces: Record<string, Workspace>,
  activeWorkspaceId: string | null,
  activeSessionId: string | null,
): string | null {
  if (activeSessionId) {
    const location = findSessionLocation(workspaces, activeSessionId)
    if (location) return location.workspace.id
  }

  if (activeWorkspaceId && workspaces[activeWorkspaceId]) {
    return activeWorkspaceId
  }

  return Object.values(workspaces)[0]?.id ?? null
}

function resolveActiveSessionId(
  workspaces: Record<string, Workspace>,
  activeWorkspaceId: string | null,
  activeSessionId: string | null,
): string | null {
  if (activeSessionId && findSessionLocation(workspaces, activeSessionId)) {
    return activeSessionId
  }

  const workspaceId = resolveActiveWorkspaceId(workspaces, activeWorkspaceId, activeSessionId)
  const workspace = workspaceId ? workspaces[workspaceId] : null
  if (!workspace) return null

  const preferredSessionId = activeSessionId && findTreeIndexForSession(workspace, activeSessionId) >= 0
    ? activeSessionId
    : workspace.lastActiveSessionId

  return resolveWorkspaceSelection(workspace, preferredSessionId).sessionId
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
  terminalLastOutput: Record<string, string>
  sessionNeedsUserInput: Record<string, boolean>
  deletingWorktrees: Set<string>
  maestroMode: boolean
  maestroFocusedSessionId: string | null
  preMaestroActiveSessionId: string | null
  automationNextRunAt: Record<string, number>
  showAutomationRunsPanel: boolean
  automationRunsPanelActionId: string | null

  setAutomationNextRunAt: (data: Record<string, number>) => void
  openAutomationRunsPanel: (actionId: string) => void
  closeAutomationRunsPanel: () => void
  toggleDiffPanel: () => void
  setDiffSelectedFile: (file: string | null) => void
  toggleSidebar: () => void
  toggleNotificationSounds: () => void
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
  setTerminalLastOutput: (sessionId: string, text: string) => void
  setSessionNeedsUserInput: (sessionId: string, needsUserInput: boolean) => void
  clearSessionNeedsUserInput: (sessionId: string) => void
  updateSessionLabel: (sessionId: string, label: string, icon?: string) => void
  deleteAllSessions: (workspaceId: string, treeIndex?: number) => void
  moveSession: (sessionId: string, direction: 'up' | 'down') => void
  addWorktree: (workspaceId: string, rootDir: string) => void
  removeWorktree: (workspaceId: string, treeIndex: number) => void
  setDeletingWorktree: (key: string, deleting: boolean) => void
  toggleMaestroMode: () => void
  setMaestroFocusedSession: (sessionId: string | null) => void
  cycleMaestroFocus: (direction: 'next' | 'prev') => void
  setActiveTree: (workspaceId: string, index: number) => void
  repairSessionConsistency: () => void
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
  terminalLastOutput: {},
  sessionNeedsUserInput: {},
  deletingWorktrees: new Set<string>(),
  maestroMode: false,
  maestroFocusedSessionId: null,
  preMaestroActiveSessionId: null,
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
  toggleDiffPanel: () => set((s) => ({ showDiffPanel: !s.showDiffPanel, diffSelectedFile: null })),
  setDiffSelectedFile: (file) => set({ diffSelectedFile: file }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  toggleNotificationSounds: () => set((s) => ({
    settings: { ...s.settings, notificationSoundsMuted: !s.settings.notificationSoundsMuted }
  })),

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
      lastActiveSessionId: sessionId,
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
        [workspaceId]: { ...workspace, trees: newTrees, lastActiveSessionId: sessionId }
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
    // Use exec profiles for Claude/Codex to launch directly without a shell
    const launchProfile = buildAgentLaunchProfile(action)
    const resolvedCommand = buildActionCommand(action)

    window.electronAPI.prewarmTerminal({ cwd: tree.rootDir })

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
    if (!shouldFocus && sessionId && state.activeSessionId) {
      // Restore previous active session
      get().setActiveSession(state.activeSessionId)
    }
    return sessionId
  },

  deleteSession: (id) => {
    set((state) => {
      const location = findSessionLocation(state.workspaces, id)
      if (!location) return state
      const workspace = location.workspace
      const treeIdx = location.treeIndex
      const tree = location.tree
      const newSessionIds = tree.sessionIds.filter((sid) => sid !== id)
      const newSessions = { ...state.sessions }
      const newSessionNeedsUserInput = { ...state.sessionNeedsUserInput }
      const newClaudeLastResponse = { ...state.claudeLastResponse }
      const newCodexLastResponse = { ...state.codexLastResponse }
      const newTerminalLastOutput = { ...state.terminalLastOutput }
      delete newSessions[id]
      delete newSessionNeedsUserInput[id]
      delete newClaudeLastResponse[id]
      delete newCodexLastResponse[id]
      delete newTerminalLastOutput[id]
      const newTrees = [...workspace.trees]
      newTrees[treeIdx] = { ...tree, sessionIds: newSessionIds }
      let newActiveSessionId = state.activeSessionId
      if (state.activeSessionId === id) {
        const oldIdx = tree.sessionIds.indexOf(id)
        // Prefer the session below, otherwise the one above
        newActiveSessionId = newSessionIds[oldIdx] ?? newSessionIds[oldIdx - 1] ?? null
      }
      const nextLastActiveSessionId = workspace.lastActiveSessionId === id
        ? newActiveSessionId
        : workspace.lastActiveSessionId
      return {
        workspaces: {
          ...state.workspaces,
          [workspace.id]: { ...workspace, trees: newTrees, lastActiveSessionId: nextLastActiveSessionId }
        },
        sessions: newSessions,
        sessionNeedsUserInput: newSessionNeedsUserInput,
        claudeLastResponse: newClaudeLastResponse,
        codexLastResponse: newCodexLastResponse,
        terminalLastOutput: newTerminalLastOutput,
        activeSessionId: newActiveSessionId
      }
    })
  },

  deleteAllSessions: (workspaceId, treeIndex) => {
    set((state) => {
      const workspace = state.workspaces[workspaceId]
      if (!workspace) return state
      const resolvedTreeIndex = treeIndex ?? workspace.activeTreeIndex
      const tree = workspace.trees[resolvedTreeIndex]
      if (!tree) return state
      const newSessions = { ...state.sessions }
      const newSessionNeedsUserInput = { ...state.sessionNeedsUserInput }
      const newClaudeLastResponse = { ...state.claudeLastResponse }
      const newCodexLastResponse = { ...state.codexLastResponse }
      const newTerminalLastOutput = { ...state.terminalLastOutput }
      for (const sid of tree.sessionIds) {
        delete newSessions[sid]
        delete newSessionNeedsUserInput[sid]
        delete newClaudeLastResponse[sid]
        delete newCodexLastResponse[sid]
        delete newTerminalLastOutput[sid]
      }
      // Create a fresh terminal session so the tree isn't empty
      const freshId = generateId()
      const freshSession: TerminalSession = {
        id: freshId,
        workspaceId,
        label: 'Terminal 1',
        processStatus: 'terminal',
        cwd: tree.rootDir,
        shellPath: ''
      }
      newSessions[freshId] = freshSession
      const newTrees = [...workspace.trees]
      newTrees[resolvedTreeIndex] = { ...tree, sessionIds: [freshId] }
      const nextLastActiveSessionId = tree.sessionIds.includes(workspace.lastActiveSessionId ?? '')
        ? freshId
        : workspace.lastActiveSessionId
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: { ...workspace, trees: newTrees, lastActiveSessionId: nextLastActiveSessionId }
        },
        sessions: newSessions,
        sessionNeedsUserInput: newSessionNeedsUserInput,
        claudeLastResponse: newClaudeLastResponse,
        codexLastResponse: newCodexLastResponse,
        terminalLastOutput: newTerminalLastOutput,
        activeSessionId: state.activeSessionId && tree.sessionIds.includes(state.activeSessionId)
          ? freshId
          : state.activeSessionId
      }
    })
  },

  setActiveWorkspace: (id) => {
    set((state) => {
      const workspace = state.workspaces[id]
      if (state.maestroMode) {
        let firstAgentId: string | null = null
        let firstSessionId: string | null = null
        if (workspace) {
          for (const tree of workspace.trees) {
            if (!firstSessionId && tree.sessionIds.length > 0) {
              firstSessionId = tree.sessionIds[0]
            }
            for (const sid of tree.sessionIds) {
              const s = state.sessions[sid]
              if (s && (s.processStatus === 'claude' || s.processStatus === 'codex')) {
                firstAgentId = sid
                break
              }
            }
            if (firstAgentId) break
          }
        }
        // Update activeSessionId so repairSessionConsistency doesn't revert the workspace
        const nextSessionId = firstSessionId ?? state.activeSessionId
        return {
          activeWorkspaceId: id,
          activeSessionId: nextSessionId,
          preMaestroActiveSessionId: nextSessionId,
          maestroFocusedSessionId: firstAgentId
        }
      }
      const selection = workspace ? resolveWorkspaceSelection(workspace) : null
      const updatedWorkspace = workspace && selection && (
        workspace.activeTreeIndex !== selection.treeIndex ||
        workspace.lastActiveSessionId !== selection.sessionId
      )
        ? { ...workspace, activeTreeIndex: selection.treeIndex, lastActiveSessionId: selection.sessionId }
        : workspace
      return {
        workspaces: updatedWorkspace && updatedWorkspace !== workspace
          ? { ...state.workspaces, [id]: updatedWorkspace }
          : state.workspaces,
        activeWorkspaceId: id,
        activeSessionId: selection?.sessionId ?? null
      }
    })
  },

  setActiveSession: (id) => {
    const state = get()
    const session = state.sessions[id]
    if (!session) {
      const location = findSessionLocation(state.workspaces, id)
      if (!location) {
        set({ activeSessionId: id })
        return
      }

      const recoveredSession = createRecoveredSession(
        id,
        location.workspace.id,
        location.tree.rootDir,
        location.tree.sessionIds.indexOf(id),
      )

      set((current) => {
        const currentWorkspace = current.workspaces[location.workspace.id]
        const updatedWorkspace = currentWorkspace
          ? {
              ...currentWorkspace,
              lastActiveSessionId: id,
              ...(currentWorkspace.activeTreeIndex !== location.treeIndex
                ? { activeTreeIndex: location.treeIndex }
                : {}),
            }
          : undefined

        return {
          workspaces: updatedWorkspace
            ? { ...current.workspaces, [location.workspace.id]: updatedWorkspace }
            : current.workspaces,
          sessions: {
            ...current.sessions,
            [id]: recoveredSession,
          },
          activeWorkspaceId: location.workspace.id,
          activeSessionId: id,
        }
      })
      return
    }
    const workspace = state.workspaces[session.workspaceId]
    const updates: Partial<AppState> = { activeSessionId: id }
    // Switch workspace if the session belongs to a different one
    if (session.workspaceId !== state.activeWorkspaceId) {
      updates.activeWorkspaceId = session.workspaceId
    }
    if (workspace) {
      const treeIndex = workspace.trees.findIndex((t) => t.sessionIds.includes(id))
      const needsTreeSwitch = treeIndex >= 0 && treeIndex !== workspace.activeTreeIndex
      const updatedWorkspace = { ...workspace, lastActiveSessionId: id, ...(needsTreeSwitch ? { activeTreeIndex: treeIndex } : {}) }
      updates.workspaces = {
        ...state.workspaces,
        [workspace.id]: updatedWorkspace
      }
    }
    set(updates)
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

  setTerminalLastOutput: (sessionId, text) => {
    set((state) => ({
      terminalLastOutput: { ...state.terminalLastOutput, [sessionId]: text }
    }))
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
          activeTreeIndex: newTreeIndex,
          lastActiveSessionId: sessionId,
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
      const nextActiveSessionId = needNewActiveSession
        ? (activeTreeAfter?.sessionIds[0] ?? null)
        : state.activeSessionId
      const nextLastActiveSessionId = tree.sessionIds.includes(workspace.lastActiveSessionId ?? '')
        ? (activeTreeAfter?.sessionIds[0] ?? null)
        : workspace.lastActiveSessionId

      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...workspace,
            trees: newTrees,
            activeTreeIndex: newActiveTreeIndex,
            lastActiveSessionId: nextLastActiveSessionId,
          }
        },
        sessions: newSessions,
        sessionNeedsUserInput: newSessionNeedsUserInput,
        activeSessionId: nextActiveSessionId
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

  toggleMaestroMode: () => {
    set((state) => {
      if (state.maestroMode) {
        // Exiting: restore previous session
        return {
          maestroMode: false,
          maestroFocusedSessionId: null,
          activeSessionId: state.preMaestroActiveSessionId ?? state.activeSessionId,
          preMaestroActiveSessionId: null
        }
      }
      // Entering: save current session, find first agent to focus
      const workspace = state.activeWorkspaceId ? state.workspaces[state.activeWorkspaceId] : null
      let firstAgentId: string | null = null
      if (workspace) {
        for (const tree of workspace.trees) {
          for (const sid of tree.sessionIds) {
            const s = state.sessions[sid]
            if (s && (s.processStatus === 'claude' || s.processStatus === 'codex')) {
              firstAgentId = sid
              break
            }
          }
          if (firstAgentId) break
        }
      }
      return {
        maestroMode: true,
        preMaestroActiveSessionId: state.activeSessionId,
        maestroFocusedSessionId: firstAgentId
      }
    })
  },

  setMaestroFocusedSession: (sessionId) => set({ maestroFocusedSessionId: sessionId }),

  cycleMaestroFocus: (direction) => {
    set((state) => {
      const workspace = state.activeWorkspaceId ? state.workspaces[state.activeWorkspaceId] : null
      if (!workspace) return state
      const agentIds: string[] = []
      for (const tree of workspace.trees) {
        for (const sid of tree.sessionIds) {
          const s = state.sessions[sid]
          if (s && (s.processStatus === 'claude' || s.processStatus === 'codex')) {
            agentIds.push(sid)
          }
        }
      }
      if (agentIds.length === 0) return state
      const currentIdx = state.maestroFocusedSessionId
        ? agentIds.indexOf(state.maestroFocusedSessionId)
        : -1
      let nextIdx: number
      if (currentIdx === -1) {
        nextIdx = 0
      } else if (direction === 'next') {
        nextIdx = (currentIdx + 1) % agentIds.length
      } else {
        nextIdx = (currentIdx - 1 + agentIds.length) % agentIds.length
      }
      return { maestroFocusedSessionId: agentIds[nextIdx] }
    })
  },

  setActiveTree: (workspaceId, index) => {
    set((state) => {
      const workspace = state.workspaces[workspaceId]
      if (!workspace || index < 0 || index >= workspace.trees.length) return state
      const tree = workspace.trees[index]
      const nextSessionId = tree.sessionIds[0] ?? null
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: { ...workspace, activeTreeIndex: index, lastActiveSessionId: nextSessionId }
        },
        activeSessionId: nextSessionId
      }
    })
  },

  repairSessionConsistency: () => {
    const state = get()
    const repairedSessions = restoreTreeSessions(state.workspaces, state.sessions)
    const repairedActiveWorkspaceId = resolveActiveWorkspaceId(
      state.workspaces,
      state.activeWorkspaceId,
      state.activeSessionId,
    )
    const repairedActiveSessionId = resolveActiveSessionId(
      state.workspaces,
      repairedActiveWorkspaceId,
      state.activeSessionId,
    )

    if (
      repairedSessions === state.sessions &&
      repairedActiveWorkspaceId === state.activeWorkspaceId &&
      repairedActiveSessionId === state.activeSessionId
    ) {
      return
    }

    set({
      sessions: repairedSessions,
      activeWorkspaceId: repairedActiveWorkspaceId,
      activeSessionId: repairedActiveSessionId,
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

    const restoredSessions = Object.fromEntries(
      Object.entries(sessions).map(([id, session]) => [id, { ...session, processStatus: restoreProcessStatus(session) }])
    )
    const repairedSessions = restoreTreeSessions(migrated, restoredSessions)

    set({
      workspaces: migrated,
      sessions: repairedSessions,
      activeWorkspaceId: resolveActiveWorkspaceId(migrated, activeWorkspaceId, activeSessionId),
      activeSessionId: resolveActiveSessionId(migrated, activeWorkspaceId, activeSessionId),
      settings: {
        worktreesDir: oldSettings?.worktreesDir ?? settings?.worktreesDir ?? '',
        notificationSoundsMuted: settings?.notificationSoundsMuted,
      },
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
