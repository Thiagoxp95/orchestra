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
  VoiceVocabularyEntry,
  VoiceSetupStatus,
  ResumableAgent,
} from '../../../shared/types'
import { DEFAULT_VOICE_SETTINGS } from '../../../shared/types'
import type { NormalizedAgentSessionStatus } from '../../../shared/agent-session-types'
import { forgetDestroyedWorktree } from '../utils/worktree-cleanup'
import {
  buildActionCommand,
  buildAgentLaunchProfile,
  buildAgentResumeCommand,
  isResumableAgent,
  CLAUDE_INTERACTIVE_COMMAND_PREVIEW,
  CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW,
  CODEX_INTERACTIVE_COMMAND_PREVIEW,
  CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW,
  CURSOR_INTERACTIVE_COMMAND_PREVIEW,
  CURSOR_INTERACTIVE_SHELL_COMMAND_PREVIEW,
  isAgentResumeCommand,
} from '../../../shared/action-utils'

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
  },
  {
    id: 'default-cursor',
    name: 'Cursor',
    icon: '__cursor__',
    command: '',
    actionType: 'cursor',
    keybinding: 'Cmd+F',
    runOnWorktreeCreation: false,
    isDefault: true
  }
]

function actionTypeToProcessStatus(actionType?: CustomAction['actionType']): ProcessStatus {
  if (actionType === 'claude') return 'claude'
  if (actionType === 'codex') return 'codex'
  if (actionType === 'cursor') return 'cursor'
  return 'terminal'
}

type AgentProcessStatus = Extract<ProcessStatus, 'claude' | 'codex' | 'cursor'>

interface AgentLaunchState {
  agent: AgentProcessStatus
  startedAt: number
  confirmed: boolean
}

function shouldAutoStartAgentRun(processStatus: ProcessStatus, initialCommand?: string): boolean {
  if (!initialCommand) return false
  // A resumed conversation comes back up waiting for input — same as a bare
  // interactive launch — so it isn't a run that started on its own.
  if (isAgentResumeCommand(initialCommand)) return false
  if (processStatus === 'claude') {
    return (
      initialCommand !== CLAUDE_INTERACTIVE_COMMAND_PREVIEW
      && initialCommand !== CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW
    )
  }
  if (processStatus === 'codex') {
    return (
      initialCommand !== CODEX_INTERACTIVE_COMMAND_PREVIEW
      && initialCommand !== CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW
    )
  }
  if (processStatus === 'cursor') {
    return (
      initialCommand !== CURSOR_INTERACTIVE_COMMAND_PREVIEW
      && initialCommand !== CURSOR_INTERACTIVE_SHELL_COMMAND_PREVIEW
    )
  }
  return false
}

function removeSessionNeedsUserInput(
  sessionNeedsUserInput: Record<string, boolean>,
  sessionId: string,
): Record<string, boolean> {
  if (!(sessionId in sessionNeedsUserInput)) return sessionNeedsUserInput
  const next = { ...sessionNeedsUserInput }
  delete next[sessionId]
  return next
}


function restoreProcessStatus(session: TerminalSession): ProcessStatus {
  // Cursor belongs here for the same reason claude and codex do: the row is
  // restored as the agent it was, so it keeps its icon and can offer to resume
  // its own conversation. Dropping it to 'terminal' made a restored cursor pane
  // indistinguishable from a plain shell.
  if (isResumableAgent(session.processStatus)) {
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
  normalizedAgentState: Record<string, NormalizedAgentSessionStatus>
  // Sessions whose PTY the main process has confirmed gone (see pty-liveness.ts).
  // A reboot puts every restored row in here — which is what makes the sidebar's
  // resume offer safe: it never appears while something is still running.
  exitedSessions: Record<string, boolean>
  agentLaunches: Record<string, AgentLaunchState>
  maestroMode: boolean
  maestroFocusedSessionId: string | null
  preMaestroActiveSessionId: string | null
  // Geometry ownership mirrored from the remote bridge (see remote-bridge.ts).
  // 'web' means a focused phone claimed the shared PTY size — desktop terminals
  // stop auto-fitting and scale to view at remoteGeometry instead. 'desktop'
  // (default) means the desktop drives the PTY and fits normally.
  remoteSessionGeometry: Record<string, { cols: number; rows: number }>
  remoteGeometryOwner: 'desktop' | 'web'
  remoteGeometry: { cols: number; rows: number } | null
  automationNextRunAt: Record<string, number>
  showAutomationRunsPanel: boolean
  automationRunsPanelActionId: string | null
  showUsagePanel: boolean
  showWorkspaceSettings: boolean
  /**
   * A close (kill PTY + drop the session) waiting on confirmation. Every close
   * path — the row's ×, middle-click, the close-session shortcut, "close all" on
   * a worktree — parks here instead of acting, and one dialog in App renders it.
   * Closing is irreversible for whatever the agent had in flight, and the two
   * cheapest gestures in the app (a stray middle-click, a reflexive ⌘W) used to
   * fire it with nothing in between.
   */
  pendingSessionClose: { sessionIds: string[]; label: string } | null
  voiceSetupStatus: VoiceSetupStatus | null
  voiceSetupAttempted: boolean
  voiceSetupCardDismissed: boolean
  voiceWizardOpen: boolean

  setVoiceSetupStatus: (status: VoiceSetupStatus | null) => void
  setVoiceSetupAttempted: (attempted: boolean) => void
  setVoiceSetupCardDismissed: (dismissed: boolean) => void
  setVoiceWizardOpen: (open: boolean) => void

  /** Ask to close these sessions; `label` names them in the dialog. */
  requestSessionClose: (sessionIds: string[], label: string) => void
  cancelSessionClose: () => void

  setAutomationNextRunAt: (data: Record<string, number>) => void
  openAutomationRunsPanel: (actionId: string) => void
  closeAutomationRunsPanel: () => void
  toggleDiffPanel: () => void
  toggleUsagePanel: () => void
  setDiffSelectedFile: (file: string | null) => void
  toggleSidebar: () => void
  toggleNotificationSounds: () => void
  updateSettings: (settings: AppSettings) => void
  updateAgentFooterControls: (override: AppSettings['agentFooterControls']) => void
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
    updates: Partial<Pick<Workspace, 'name' | 'color' | 'emoji' | 'notificationSound' | 'questionNotificationSound' | 'repositorySettings' | 'viewMode' | 'linearConfig' | 'interruptionMode' | 'interruptionPosition'>>
  ) => void
  createSession: (workspaceId: string, initialCommand?: string, actionId?: string, actionIcon?: string, actionName?: string, processStatus?: ProcessStatus, launchProfile?: TerminalLaunchProfile, treeIndex?: number, cwd?: string) => string
  runAction: (workspaceId: string, action: CustomAction, opts?: { forceDefaultTree?: boolean }) => string
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
  setNormalizedAgentState: (status: NormalizedAgentSessionStatus) => void
  clearNormalizedAgentState: (sessionId: string) => void
  startAgentRun: (sessionId: string) => void
  confirmAgentLaunch: (sessionId: string, agent: AgentProcessStatus) => void
  clearAgentLaunch: (sessionId: string) => void
  updateSessionLabel: (sessionId: string, label: string, icon?: string) => void
  setSessionPinned: (sessionId: string, pinned: boolean) => void
  setExitedSessions: (sessionIds: string[]) => void
  setSessionResumePairing: (sessionId: string, pairing: { agent: ResumableAgent; resumeSessionId: string }) => void
  resumeSessionInPlace: (sessionId: string) => boolean
  renameSession: (sessionId: string, title: string) => void
  deleteAllSessions: (workspaceId: string, treeIndex?: number) => void
  moveSession: (sessionId: string, direction: 'up' | 'down') => void
  addWorktree: (workspaceId: string, rootDir: string) => void
  removeWorktree: (workspaceId: string, treeIndex: number) => void
  updateWorktreeDisplayName: (workspaceId: string, treeIndex: number, displayName: string) => void
  setRemoteGeometryOwner: (owner: 'desktop' | 'web', geometry: { cols: number; rows: number } | null, sessionId?: string) => void
  toggleMaestroMode: () => void
  setMaestroFocusedSession: (sessionId: string | null) => void
  cycleMaestroFocus: (direction: 'next' | 'prev') => void
  setActiveTree: (workspaceId: string, index: number) => void
  setShowWorkspaceSettings: (show: boolean) => void
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
  settings: { worktreesDir: '', voice: DEFAULT_VOICE_SETTINGS },
  showDiffPanel: false,
  diffSelectedFile: null,
  sidebarCollapsed: false,
  claudeLastResponse: {},
  claudeWorkState: {},
  codexLastResponse: {},
  codexWorkState: {},
  terminalLastOutput: {},
  sessionNeedsUserInput: {},
  normalizedAgentState: {},
  agentLaunches: {},
  exitedSessions: {},
  maestroMode: false,
  maestroFocusedSessionId: null,
  preMaestroActiveSessionId: null,
  remoteSessionGeometry: {},
  remoteGeometryOwner: 'desktop',
  remoteGeometry: null,
  automationNextRunAt: {},
  showAutomationRunsPanel: false,
  automationRunsPanelActionId: null,
  showUsagePanel: false,
  showWorkspaceSettings: false,
  pendingSessionClose: null,
  voiceSetupStatus: null,
  voiceSetupAttempted: false,
  voiceSetupCardDismissed: false,
  voiceWizardOpen: false,

  setVoiceSetupStatus: (status) => {
    set((s) => {
      // Reset the dismissal whenever a fresh `failed` stage arrives so the
      // card resurfaces on every new failure.
      const dismissed = status?.stage === 'failed' && s.voiceSetupStatus?.stage !== 'failed'
        ? false
        : s.voiceSetupCardDismissed
      if (dismissed !== s.voiceSetupCardDismissed) {
        // Persist the reset asynchronously (no await — fire and forget).
        try { window.electronAPI.voiceSetSetupCardDismissed(false) } catch {}
      }
      return { voiceSetupStatus: status, voiceSetupCardDismissed: dismissed }
    })
  },
  setVoiceSetupAttempted: (attempted) => {
    set((s) => (s.voiceSetupAttempted === attempted ? s : { voiceSetupAttempted: attempted }))
    try { window.electronAPI.voiceSetSetupAttempted(attempted) } catch {}
  },
  setVoiceSetupCardDismissed: (dismissed) => {
    set({ voiceSetupCardDismissed: dismissed })
    try { window.electronAPI.voiceSetSetupCardDismissed(dismissed) } catch {}
  },
  setVoiceWizardOpen: (open) => set({ voiceWizardOpen: open }),

  setAutomationNextRunAt: (data) => set({ automationNextRunAt: data }),

  setShowWorkspaceSettings: (show) => set({ showWorkspaceSettings: show }),

  requestSessionClose: (sessionIds, label) => {
    const ids = sessionIds.filter((id) => get().sessions[id])
    if (ids.length === 0) return
    // The pin is the "I mean to keep this one" mark, so it's the only close worth
    // a dialog. Everything else closes on the spot — a scratch session shouldn't
    // cost a second gesture. A mixed request closes the unpinned ones and still
    // asks about the pinned remainder.
    const pinned = ids.filter((id) => get().sessions[id]?.pinned)
    for (const id of ids) {
      if (pinned.includes(id)) continue
      window.electronAPI.killTerminal(id)
      get().deleteSession(id)
    }
    if (pinned.length === 0) return
    set({ pendingSessionClose: { sessionIds: pinned, label } })
  },
  cancelSessionClose: () => set({ pendingSessionClose: null }),
  openAutomationRunsPanel: (actionId) => set({
    showAutomationRunsPanel: true,
    automationRunsPanelActionId: actionId,
  }),
  closeAutomationRunsPanel: () => set({
    showAutomationRunsPanel: false,
    automationRunsPanelActionId: null,
  }),
  toggleDiffPanel: () => set((s) => ({ showDiffPanel: !s.showDiffPanel, diffSelectedFile: null })),
  toggleUsagePanel: () => set((s) => ({ showUsagePanel: !s.showUsagePanel })),
  setDiffSelectedFile: (file) => set({ diffSelectedFile: file }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  toggleNotificationSounds: () => set((s) => ({
    settings: { ...s.settings, notificationSoundsMuted: !s.settings.notificationSoundsMuted }
  })),
  updateSettings: (settings) => {
    set({ settings })
  },

  updateAgentFooterControls: (override) => {
    set((s) => ({ settings: { ...s.settings, agentFooterControls: override } }))
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
      const newAgentLaunches = { ...state.agentLaunches }
      for (const tree of workspace.trees) {
        for (const sid of tree.sessionIds) {
          delete newSessions[sid]
          delete newSessionNeedsUserInput[sid]
          delete newAgentLaunches[sid]
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
        agentLaunches: newAgentLaunches,
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

  createSession: (workspaceId, initialCommand?, actionId?, actionIcon?, actionName?, processStatus = 'terminal', launchProfile?, treeIndex?, cwd?) => {
    const state = get()
    const workspace = state.workspaces[workspaceId]
    if (!workspace) return ''
    const targetTreeIndex = treeIndex ?? workspace.activeTreeIndex
    const tree = workspace.trees[targetTreeIndex] ?? workspace.trees[0]
    const sessionId = generateId()
    const baseName = actionName
      ?? (processStatus === 'claude' ? 'Claude'
        : processStatus === 'codex' ? 'Codex'
        : 'Terminal')
    const existingCount = tree.sessionIds.filter((sid) => {
      const s = state.sessions[sid]
      return s && s.label.startsWith(baseName)
    }).length
    const session: TerminalSession = {
      id: sessionId,
      workspaceId,
      label: `${baseName} ${existingCount + 1}`,
      processStatus,
      // Normally the tree's directory; overridden when resuming an agent
      // conversation that ran somewhere outside this workspace's worktrees.
      cwd: cwd ?? tree.rootDir,
      shellPath: '',
      initialCommand,
      launchProfile,
      actionId,
      actionIcon
    }
    const newTrees = [...workspace.trees]
    newTrees[targetTreeIndex] = {
      ...tree,
      sessionIds: [...tree.sessionIds, sessionId]
    }
    set((s) => ({
      workspaces: {
        ...s.workspaces,
        [workspaceId]: { ...workspace, trees: newTrees, lastActiveSessionId: sessionId }
      },
      sessions: { ...s.sessions, [sessionId]: session },
      activeSessionId: sessionId,
      ...(processStatus === 'claude'
        ? {
            claudeWorkState: { ...s.claudeWorkState, [sessionId]: 'idle' as const },
            claudeLastResponse: { ...s.claudeLastResponse, [sessionId]: '' },
            sessionNeedsUserInput: removeSessionNeedsUserInput(s.sessionNeedsUserInput, sessionId),
          }
        : {}),
      ...(processStatus === 'codex'
        ? {
            codexWorkState: { ...s.codexWorkState, [sessionId]: 'idle' as const },
            codexLastResponse: { ...s.codexLastResponse, [sessionId]: '' },
            sessionNeedsUserInput: removeSessionNeedsUserInput(s.sessionNeedsUserInput, sessionId),
          }
        : {}),
      // The launch intent, recorded for EVERY agent session — not just the ones
      // that auto-start a run. It's what the pane knows about itself before `ps`
      // has caught up: the PTY's shell needs a beat to exec the agent, and
      // process-monitor's first poll in that window honestly reports 'terminal'.
      // Without this entry useProcessStatus accepts that downgrade (the pane
      // drops to the raw grid for a poll or two, which is the terminal flash on
      // every new Claude/Codex session). Unconfirmed launches are verified
      // against the live session list after AGENT_LAUNCH_GRACE_MS, so an agent
      // that genuinely failed to start still falls back to the terminal.
      ...(processStatus === 'claude' || processStatus === 'codex' || processStatus === 'cursor'
        ? {
            agentLaunches: {
              ...s.agentLaunches,
              [sessionId]: { agent: processStatus, startedAt: Date.now(), confirmed: false },
            },
          }
        : {}),
    }))
    if (shouldAutoStartAgentRun(processStatus, initialCommand)) {
      get().startAgentRun(sessionId)
    }
    return sessionId
  },

  runAction: (workspaceId, action, opts) => {
    const state = get()
    const workspace = state.workspaces[workspaceId]
    if (!workspace) return ''
    // Automated/webhook runs always use the default (first) tree — never worktrees
    const tree = opts?.forceDefaultTree ? workspace.trees[0] : activeTree(workspace)
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
        const nextProcessStatus = actionTypeToProcessStatus(action.actionType)
        if (nextProcessStatus === 'claude' || nextProcessStatus === 'codex' || nextProcessStatus === 'cursor') {
          set((s) => {
            const existingSession = s.sessions[existingSessionId]
            if (!existingSession) return s

            return {
              sessions: {
                ...s.sessions,
                [existingSessionId]: {
                  ...existingSession,
                  processStatus: nextProcessStatus,
                },
              },
              ...(nextProcessStatus === 'claude'
                ? {
                    claudeWorkState: { ...s.claudeWorkState, [existingSessionId]: 'idle' as const },
                    claudeLastResponse: { ...s.claudeLastResponse, [existingSessionId]: '' },
                    sessionNeedsUserInput: removeSessionNeedsUserInput(s.sessionNeedsUserInput, existingSessionId),
                  }
                : {
                    codexWorkState: { ...s.codexWorkState, [existingSessionId]: 'idle' as const },
                    codexLastResponse: { ...s.codexLastResponse, [existingSessionId]: '' },
                    sessionNeedsUserInput: removeSessionNeedsUserInput(s.sessionNeedsUserInput, existingSessionId),
                  }),
            }
          })
          if (shouldAutoStartAgentRun(nextProcessStatus, resolvedCommand)) {
            get().startAgentRun(existingSessionId)
          }
        }
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
      opts?.forceDefaultTree ? 0 : undefined,
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
      const newNormalizedAgentState = { ...state.normalizedAgentState }
      const newClaudeLastResponse = { ...state.claudeLastResponse }
      const newCodexLastResponse = { ...state.codexLastResponse }
      const newTerminalLastOutput = { ...state.terminalLastOutput }
      const newAgentLaunches = { ...state.agentLaunches }
      delete newSessions[id]
      delete newSessionNeedsUserInput[id]
      delete newNormalizedAgentState[id]
      delete newClaudeLastResponse[id]
      delete newCodexLastResponse[id]
      delete newTerminalLastOutput[id]
      delete newAgentLaunches[id]
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
        normalizedAgentState: newNormalizedAgentState,
        claudeLastResponse: newClaudeLastResponse,
        codexLastResponse: newCodexLastResponse,
        terminalLastOutput: newTerminalLastOutput,
        agentLaunches: newAgentLaunches,
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
      const newNormalizedAgentState = { ...state.normalizedAgentState }
      const newClaudeLastResponse = { ...state.claudeLastResponse }
      const newCodexLastResponse = { ...state.codexLastResponse }
      const newTerminalLastOutput = { ...state.terminalLastOutput }
      const newAgentLaunches = { ...state.agentLaunches }
      for (const sid of tree.sessionIds) {
        delete newSessions[sid]
        delete newSessionNeedsUserInput[sid]
        delete newNormalizedAgentState[sid]
        delete newClaudeLastResponse[sid]
        delete newCodexLastResponse[sid]
        delete newTerminalLastOutput[sid]
        delete newAgentLaunches[sid]
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
        normalizedAgentState: newNormalizedAgentState,
        claudeLastResponse: newClaudeLastResponse,
        codexLastResponse: newCodexLastResponse,
        terminalLastOutput: newTerminalLastOutput,
        agentLaunches: newAgentLaunches,
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
              if (s && (s.processStatus === 'claude' || s.processStatus === 'codex' || s.processStatus === 'cursor')) {
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
    // Viewing a session acknowledges any pending "needs input" signal —
    // the yellow indicator should clear once the user actually opens it.
    if (state.sessionNeedsUserInput[id]) {
      set((current) => ({
        sessionNeedsUserInput: removeSessionNeedsUserInput(current.sessionNeedsUserInput, id),
      }))
    }
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
      const next: Partial<AppState> = {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, processStatus: status }
        },
      }

      if (session.processStatus !== 'claude' && status === 'claude') {
        next.claudeWorkState = { ...state.claudeWorkState, [sessionId]: 'idle' }
        next.claudeLastResponse = { ...state.claudeLastResponse, [sessionId]: '' }
        next.sessionNeedsUserInput = removeSessionNeedsUserInput(state.sessionNeedsUserInput, sessionId)

        if (sessionId in state.normalizedAgentState) {
          const normalizedAgentState = { ...state.normalizedAgentState }
          delete normalizedAgentState[sessionId]
          next.normalizedAgentState = normalizedAgentState
        }
      }

      return next
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

  // Pin / unpin. Ordering lives in the render pass (pinned first, in their
  // existing relative order) rather than in tree.sessionIds, so unpinning drops a
  // session back exactly where it was instead of to the bottom of the list.
  /**
   * Record which conversation this pane is holding, as the main process
   * resolved it. Persisted with the row (see TerminalSession.resumeSessionId) —
   * that is the whole value of it, because the pane's own process will not
   * survive the reboot that makes this worth knowing.
   */
  setExitedSessions: (sessionIds) => {
    set(() => ({ exitedSessions: Object.fromEntries(sessionIds.map((id) => [id, true])) }))
  },

  setSessionResumePairing: (sessionId, pairing) => {
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return state
      if (session.resumeSessionId === pairing.resumeSessionId && session.resumeAgent === pairing.agent) {
        return state
      }
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, resumeSessionId: pairing.resumeSessionId, resumeAgent: pairing.agent },
        },
      }
    })
  },

  /**
   * Relaunch this pane on the conversation it was holding.
   *
   * In place, under the same session id, rather than spawning a sibling: the row
   * already carries the name, the pin, the position in its worktree and the
   * person's memory of what it was — a resume that appears as a second row
   * beside a dead one makes them do the tidying by hand. The PTY is killed and
   * the pane is remounted with the resume command as its initial command, which
   * is exactly the path a freshly created session takes.
   *
   * Returns false when the row has no conversation recorded (it never resolved
   * one, or it predates this being tracked) — the caller shows no button.
   */
  resumeSessionInPlace: (sessionId) => {
    const state = get()
    const session = state.sessions[sessionId]
    if (!session?.resumeSessionId) return false
    const agent = session.resumeAgent ?? (isResumableAgent(session.processStatus) ? session.processStatus : null)
    if (!agent) return false
    const command = buildAgentResumeCommand(agent, session.resumeSessionId)
    window.electronAPI.killTerminal(sessionId)
    set((current) => {
      const target = current.sessions[sessionId]
      if (!target) return current
      return {
        sessions: {
          ...current.sessions,
          [sessionId]: {
            ...target,
            initialCommand: command,
            processStatus: agent,
            // Bumped so the terminal pane remounts and creates a new PTY under
            // the same session id, rather than re-attaching to the dead one.
            respawnKey: (target.respawnKey ?? 0) + 1,
          },
        },
      }
    })
    get().setActiveSession(sessionId)
    return true
  },

  setSessionPinned: (sessionId, pinned) => {
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session || Boolean(session.pinned) === pinned) return state
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, pinned: pinned || undefined }
        }
      }
    })
  },

  // A typed title. Blank hands the name back to the auto label (the last prompt).
  renameSession: (sessionId, title) => {
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return state
      const trimmed = title.trim()
      const customLabel = trimmed || undefined
      if (session.customLabel === customLabel) return state
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, customLabel }
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

  setNormalizedAgentState: (status) => {
    set((state) => {
      const next: Partial<AppState> = {
        normalizedAgentState: { ...state.normalizedAgentState, [status.sessionId]: status }
      }

      if (
        status.agent === 'codex'
        && (
          status.state === 'working'
          || status.state === 'waitingApproval'
          || status.state === 'waitingUserInput'
          || status.state === 'idle'
        )
      ) {
        next.codexWorkState = { ...state.codexWorkState, [status.sessionId]: status.state }
      }

      return next
    })
  },

  clearNormalizedAgentState: (sessionId) => {
    set((state) => {
      if (!(sessionId in state.normalizedAgentState)) return state
      const next = { ...state.normalizedAgentState }
      delete next[sessionId]
      return { normalizedAgentState: next }
    })
  },

  startAgentRun: (sessionId) => {
    const session = get().sessions[sessionId]
    if (!session) return
    if (session.processStatus !== 'claude' && session.processStatus !== 'codex') return

    const startedAt = Date.now()

    if (session.processStatus === 'claude') {
      set((state) => ({
        claudeWorkState: { ...state.claudeWorkState, [sessionId]: 'idle' },
        claudeLastResponse: { ...state.claudeLastResponse, [sessionId]: '' },
        sessionNeedsUserInput: removeSessionNeedsUserInput(state.sessionNeedsUserInput, sessionId),
        agentLaunches: {
          ...state.agentLaunches,
          [sessionId]: { agent: 'claude', startedAt, confirmed: false },
        },
      }))
      // Resync from main: we just reset claudeWorkState to 'idle', but if the
      // user queued input into an already-thinking Claude, main has 'working'
      // and won't re-emit IPC (it only fires on transitions). Without this pull
      // the sidebar stays stuck at 'idle' until Claude finally goes idle.
      window.electronAPI.getClaudeWorkState(sessionId).then((workState) => {
        if (workState !== 'working') return
        const current = get()
        if (current.sessions[sessionId]?.processStatus !== 'claude') return
        if (current.agentLaunches[sessionId]?.startedAt !== startedAt) return
        if (current.claudeWorkState[sessionId] === 'working') return
        set((state) => ({
          claudeWorkState: { ...state.claudeWorkState, [sessionId]: 'working' },
        }))
      }).catch(() => {})
      return
    }

    set((state) => ({
      codexWorkState: { ...state.codexWorkState, [sessionId]: 'working' },
      codexLastResponse: { ...state.codexLastResponse, [sessionId]: '' },
      sessionNeedsUserInput: removeSessionNeedsUserInput(state.sessionNeedsUserInput, sessionId),
      agentLaunches: {
        ...state.agentLaunches,
        [sessionId]: { agent: 'codex', startedAt, confirmed: false },
      },
    }))
    window.electronAPI.codexSessionStarted(sessionId)
  },

  confirmAgentLaunch: (sessionId, agent) => {
    set((state) => {
      const current = state.agentLaunches[sessionId]
      if (!current || current.agent !== agent || current.confirmed) return state
      return {
        agentLaunches: {
          ...state.agentLaunches,
          [sessionId]: { ...current, confirmed: true },
        },
      }
    })
  },

  clearAgentLaunch: (sessionId) => {
    set((state) => {
      if (!(sessionId in state.agentLaunches)) return state
      const next = { ...state.agentLaunches }
      delete next[sessionId]
      return { agentLaunches: next }
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
    // An intentional add (new worktree, restore from the bin) clears the delete
    // tombstone, so the sidebar's git auto-discovery may track this path again.
    forgetDestroyedWorktree(rootDir)
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
      const newAgentLaunches = { ...state.agentLaunches }
      for (const sid of tree.sessionIds) {
        delete newSessions[sid]
        delete newSessionNeedsUserInput[sid]
        delete newAgentLaunches[sid]
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
        agentLaunches: newAgentLaunches,
        activeSessionId: nextActiveSessionId
      }
    })
  },

  updateWorktreeDisplayName: (workspaceId, treeIndex, displayName) => {
    set((state) => {
      const workspace = state.workspaces[workspaceId]
      if (!workspace || treeIndex < 0 || treeIndex >= workspace.trees.length) return state

      const tree = workspace.trees[treeIndex]
      const trimmed = displayName.trim()
      const nextTree: WorkspaceTree = trimmed
        ? { ...tree, displayName: trimmed }
        : { rootDir: tree.rootDir, sessionIds: tree.sessionIds }
      const newTrees = [...workspace.trees]
      newTrees[treeIndex] = nextTree

      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: { ...workspace, trees: newTrees },
        },
      }
    })
  },

  setRemoteGeometryOwner: (owner, geometry, sessionId) => {
    if (sessionId) {
      set((state) => {
        const remoteSessionGeometry = { ...state.remoteSessionGeometry }
        if (owner === 'web' && geometry) remoteSessionGeometry[sessionId] = geometry
        else delete remoteSessionGeometry[sessionId]
        return { remoteSessionGeometry }
      })
      return
    }
    set({ remoteGeometryOwner: owner, remoteGeometry: owner === 'web' ? geometry : null })
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
            if (s && (s.processStatus === 'claude' || s.processStatus === 'codex' || s.processStatus === 'cursor')) {
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
          if (s && (s.processStatus === 'claude' || s.processStatus === 'codex' || s.processStatus === 'cursor')) {
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
        // Ensure default actions are present, inserted after the preceding default
        // so e.g. `default-cursor` lands right after `default-codex` rather than at the end.
        const ids = new Set(base.customActions.map((a) => a.id))
        const missing = DEFAULT_ACTIONS.filter((d) => !ids.has(d.id))
        if (missing.length > 0) {
          const next = [...base.customActions]
          for (const def of missing) {
            const defIdx = DEFAULT_ACTIONS.findIndex((d) => d.id === def.id)
            let insertAt = next.length
            for (let i = defIdx - 1; i >= 0; i--) {
              const prevId = DEFAULT_ACTIONS[i].id
              const idx = next.findIndex((a) => a.id === prevId)
              if (idx !== -1) {
                insertAt = idx + 1
                break
              }
            }
            next.splice(insertAt, 0, def)
          }
          base = { ...base, customActions: next }
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
        keybindingOverrides: settings?.keybindingOverrides,
        agentFooterControls: settings?.agentFooterControls,
        voice: settings?.voice ?? DEFAULT_VOICE_SETTINGS,
      },
      claudeLastResponse: claudeLastResponse ?? {},
      codexLastResponse: codexLastResponse ?? {},
      sessionNeedsUserInput: {},
      normalizedAgentState: {},
      agentLaunches: {},
    })
  }
}))

/** Helper for components to get the active tree */
export function getActiveTree(ws: Workspace): WorkspaceTree {
  return activeTree(ws)
}

/**
 * Build the voice vocabulary for a workspace. Each non-default action
 * contributes its lowercased name plus any voiceAliases. Default actions are
 * skipped — they exist on every workspace and aren't user-configured.
 */
export function buildVoiceVocabularyForWorkspace(workspace: Workspace | null | undefined): VoiceVocabularyEntry[] {
  if (!workspace) return []
  const entries: VoiceVocabularyEntry[] = []
  for (const action of workspace.customActions) {
    if (action.isDefault) continue
    const phrases = new Set<string>()
    if (action.name) phrases.add(action.name.toLowerCase().trim())
    for (const alias of action.voiceAliases ?? []) {
      const trimmed = alias.trim().toLowerCase()
      if (trimmed) phrases.add(trimmed)
    }
    if (phrases.size === 0) continue
    entries.push({ actionId: action.id, phrases: Array.from(phrases) })
  }
  return entries
}
