// src/shared/types.ts

export interface Workspace {
  id: string
  name: string
  color: string
  sessionIds: string[]
  createdAt: number
}

export interface TerminalSession {
  id: string
  workspaceId: string
  label: string
  processStatus: ProcessStatus
  cwd: string
  shellPath: string
}

export type ProcessStatus = 'terminal' | 'claude' | 'codex'

export interface PersistedData {
  workspaces: Record<string, Workspace>
  sessions: Record<string, TerminalSession & {
    scrollback: string
    env: Record<string, string>
  }>
  activeWorkspaceId: string | null
  activeSessionId: string | null
}

export interface CreateTerminalOpts {
  cwd: string
  shell?: string
}

export interface ElectronAPI {
  createTerminal: (sessionId: string, opts: CreateTerminalOpts) => void
  killTerminal: (sessionId: string) => void
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void
  writeTerminal: (sessionId: string, data: string) => void
  onTerminalData: (callback: (sessionId: string, data: string) => void) => void
  onProcessChange: (callback: (sessionId: string, status: ProcessStatus) => void) => void
  onTerminalExit: (callback: (sessionId: string) => void) => void
  captureScrollback: (sessionId: string) => Promise<string>
  getCwd: (sessionId: string) => Promise<string>
  getPersistedData: () => Promise<PersistedData | null>
  removeAllListeners: () => void
}
