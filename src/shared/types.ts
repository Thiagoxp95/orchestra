// src/shared/types.ts

export interface WorkspaceTree {
  rootDir: string
  sessionIds: string[]
}

export interface Workspace {
  id: string
  name: string
  color: string
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

export interface CustomAction {
  id: string
  name: string
  icon: string // hugeicons name or '__claude__' | '__openai__' | '__terminal__'
  command: string
  keybinding: string
  runOnWorktreeCreation: boolean
  singleSession?: boolean
  focusOnCreation?: boolean
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
}

export interface CreateTerminalOpts {
  cwd: string
  shell?: string
  cols?: number
  rows?: number
  initialCommand?: string
}

export interface ElectronAPI {
  createTerminal: (sessionId: string, opts: CreateTerminalOpts) => void
  killTerminal: (sessionId: string) => void
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void
  writeTerminal: (sessionId: string, data: string) => void
  onTerminalData: (callback: (sessionId: string, data: string) => void) => () => void
  onProcessChange: (callback: (sessionId: string, status: ProcessStatus) => void) => void
  onTerminalExit: (callback: (sessionId: string) => void) => void
  onTerminalSnapshot: (callback: (sessionId: string, snapshot: any) => void) => () => void
  captureScrollback: (sessionId: string) => Promise<string>
  getCwd: (sessionId: string) => Promise<string>
  getPersistedData: () => Promise<PersistedData | null>
  selectDirectory: () => Promise<string | null>
  onCloseActiveSession: (callback: () => void) => () => void
  removeAllListeners: () => void
  getGitBranch: (cwd: string) => Promise<string | null>
  createWorktree: (repoDir: string, branch: string, worktreesDir: string) => Promise<{ success: boolean; path?: string; error?: string }>
  saveState: (data: {
    workspaces: Record<string, Workspace>
    sessions: Record<string, TerminalSession>
    activeWorkspaceId: string | null
    activeSessionId: string | null
    settings: AppSettings
  }) => void
}
