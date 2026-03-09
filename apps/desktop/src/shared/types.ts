// src/shared/types.ts

export interface WorkspaceTree {
  rootDir: string
  sessionIds: string[]
}

export interface Workspace {
  id: string
  name: string
  color: string
  emoji?: string
  trees: WorkspaceTree[]
  activeTreeIndex: number
  customActions: CustomAction[]
  createdAt: number
}

export interface TerminalSession {
  id: string
  workspaceId: string
  label: string
  processStatus: ProcessStatus
  cwd: string
  shellPath: string
  initialCommand?: string
  actionId?: string
  actionIcon?: string
}

export type ProcessStatus = 'terminal' | 'claude' | 'codex'

export type ActionType = 'cli' | 'claude' | 'codex'
export type WriteSource = 'user' | 'system'

export interface PromptRecord {
  sessionId: string
  submittedAt: string
  text: string
}

export interface CustomAction {
  id: string
  name: string
  icon: string // hugeicons name or '__claude__' | '__openai__' | '__terminal__'
  command: string
  actionType?: ActionType
  keybinding: string
  runOnWorktreeCreation: boolean
  runOnWorktreeDestruction?: boolean
  singleSession?: boolean
  focusOnCreation?: boolean
  runInBackground?: boolean
  isDefault?: boolean
}

export interface AppSettings {
  worktreesDir: string
}

export interface PersistedData {
  workspaces: Record<string, Workspace>
  sessions: Record<string, TerminalSession & {
    scrollback: string
    env: Record<string, string>
  }>
  activeWorkspaceId: string | null
  activeSessionId: string | null
  settings: AppSettings
  claudeLastResponse: Record<string, string>
  codexLastResponse: Record<string, string>
}

export type ClaudeWorkState = 'idle' | 'working'
export type CodexWorkState = 'idle' | 'working'

export interface IdleNotification {
  sessionId: string
  summary: string
  agentType: 'claude' | 'codex'
}

export interface CreateTerminalOpts {
  cwd: string
  shell?: string
  cols?: number
  rows?: number
  initialCommand?: string
}

export interface LiveTerminalSessionInfo {
  sessionId: string
  pid: number | null
  cwd: string
  isAlive: boolean
}

export interface LiveTerminalSessionStatusInfo extends LiveTerminalSessionInfo {
  status: ProcessStatus
  aiPid: number | null
}

export interface ElectronAPI {
  createTerminal: (sessionId: string, opts: CreateTerminalOpts) => void
  killTerminal: (sessionId: string) => void
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void
  writeTerminal: (sessionId: string, data: string, source?: WriteSource) => void
  onTerminalData: (callback: (sessionId: string, data: string) => void) => () => void
  onProcessChange: (callback: (sessionId: string, status: ProcessStatus, aiPid?: number) => void) => void
  onTerminalExit: (callback: (sessionId: string) => void) => void
  onTerminalSnapshot: (callback: (sessionId: string, snapshot: any) => void) => () => void
  captureScrollback: (sessionId: string) => Promise<string>
  getCwd: (sessionId: string) => Promise<string>
  getPersistedData: () => Promise<PersistedData | null>
  listLiveSessions: () => Promise<LiveTerminalSessionInfo[]>
  listLiveSessionStatuses: () => Promise<LiveTerminalSessionStatusInfo[]>
  selectDirectory: () => Promise<string | null>
  claudeWatchSession: (sessionId: string, cwd: string, claudePid?: number) => void
  claudeUnwatchSession: (sessionId: string) => void
  onClaudeLastResponse: (callback: (sessionId: string, text: string) => void) => () => void
  onClaudeWorkState: (callback: (sessionId: string, state: ClaudeWorkState) => void) => () => void
  codexWatchSession: (sessionId: string, cwd: string, codexPid?: number) => void
  codexUnwatchSession: (sessionId: string) => void
  onCodexLastResponse: (callback: (sessionId: string, text: string) => void) => () => void
  onCodexWorkState: (callback: (sessionId: string, state: CodexWorkState) => void) => () => void
  onIdleNotification: (callback: (notification: IdleNotification) => void) => () => void
  navigateToSession: (sessionId: string) => void
  onNavigateToSession: (callback: (sessionId: string) => void) => () => void
  onSessionLabelUpdate: (callback: (sessionId: string, label: string) => void) => () => void
  onCloseActiveSession: (callback: () => void) => () => void
  removeAllListeners: () => void
  getGitBranch: (cwd: string) => Promise<string | null>
  getGitDiffStat: (cwd: string) => Promise<{ added: number; removed: number } | null>
  getGitDiffFiles: (cwd: string) => Promise<{ file: string; added: number; removed: number; status: string }[]>
  getGitFileDiff: (cwd: string, file: string) => Promise<string>
  runBackgroundCommand: (cwd: string, command: string) => Promise<{ success: boolean; error?: string }>
  createWorktree: (repoDir: string, branch: string, worktreesDir: string) => Promise<{ success: boolean; path?: string; error?: string }>
  removeWorktree: (mainRepoDir: string, worktreeDir: string) => Promise<{ success: boolean; error?: string }>
  getListeningPorts: () => Promise<{ port: number; pid: number; sessionId: string }[]>
  killPort: (pid: number) => Promise<{ success: boolean; error?: string }>
  getCodexDebugState: () => Promise<Record<string, unknown>[]>
  getPromptHistory: (sessionId: string) => Promise<PromptRecord[]>
  saveState: (data: {
    workspaces: Record<string, Workspace>
    sessions: Record<string, TerminalSession>
    activeWorkspaceId: string | null
    activeSessionId: string | null
    settings: AppSettings
    claudeLastResponse: Record<string, string>
    codexLastResponse: Record<string, string>
  }) => void
}
