// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron'
import type {
  ElectronAPI,
  CreateTerminalOpts,
  ProcessStatus,
  ClaudeWorkState,
  CodexWorkState,
  WriteSource,
  IdleNotification,
  RepositoryWorkspaceSettings,
} from '../shared/types'

const api: ElectronAPI = {
  createTerminal: (sessionId: string, opts: CreateTerminalOpts) => {
    ipcRenderer.send('terminal-create', sessionId, opts)
  },
  prewarmTerminal: (opts: { cwd: string; cols?: number; rows?: number }) => {
    ipcRenderer.send('terminal-prewarm', opts)
  },
  killTerminal: (sessionId: string) => {
    ipcRenderer.send('terminal-kill', sessionId)
  },
  resizeTerminal: (sessionId: string, cols: number, rows: number) => {
    ipcRenderer.send('terminal-resize', sessionId, cols, rows)
  },
  writeTerminal: (sessionId: string, data: string, source: WriteSource = 'user') => {
    ipcRenderer.send('terminal-write', sessionId, data, source)
  },
  onTerminalData: (callback: (sessionId: string, data: string) => void) => {
    const handler = (_event: any, sessionId: string, data: string) => callback(sessionId, data)
    ipcRenderer.on('terminal-data', handler)
    return () => { ipcRenderer.removeListener('terminal-data', handler) }
  },
  onProcessChange: (callback: (sessionId: string, status: ProcessStatus, aiPid?: number) => void) => {
    ipcRenderer.on('process-change', (_event, sessionId, status, aiPid) => callback(sessionId, status, aiPid))
  },
  onTerminalExit: (callback: (sessionId: string) => void) => {
    ipcRenderer.on('terminal-exit', (_event, sessionId) => callback(sessionId))
  },
  onTerminalSnapshot: (callback: (sessionId: string, snapshot: any) => void) => {
    const handler = (_event: any, sessionId: string, snapshot: any) => callback(sessionId, snapshot)
    ipcRenderer.on('terminal-snapshot', handler)
    return () => { ipcRenderer.removeListener('terminal-snapshot', handler) }
  },
  captureScrollback: (sessionId: string) => {
    return ipcRenderer.invoke('terminal-capture-scrollback', sessionId)
  },
  getCwd: (sessionId: string) => {
    return ipcRenderer.invoke('terminal-get-cwd', sessionId)
  },
  getPersistedData: () => {
    return ipcRenderer.invoke('get-persisted-data')
  },
  getRepositoryWorkspaceSettings: (rootDir: string) => {
    return ipcRenderer.invoke('get-repository-workspace-settings', rootDir)
  },
  saveRepositoryWorkspaceSettings: (
    rootDir: string,
    settings: RepositoryWorkspaceSettings | null,
  ) => {
    return ipcRenderer.invoke('save-repository-workspace-settings', rootDir, settings)
  },
  listLiveSessions: () => {
    return ipcRenderer.invoke('list-live-sessions')
  },
  listLiveSessionStatuses: () => {
    return ipcRenderer.invoke('list-live-session-statuses')
  },
  claudeWatchSession: (sessionId: string, cwd: string, claudePid?: number) => {
    ipcRenderer.send('claude-watch-session', sessionId, cwd, claudePid)
  },
  claudeUnwatchSession: (sessionId: string) => {
    ipcRenderer.send('claude-unwatch-session', sessionId)
  },
  onClaudeLastResponse: (callback: (sessionId: string, text: string) => void) => {
    const handler = (_event: any, sessionId: string, text: string) => callback(sessionId, text)
    ipcRenderer.on('claude-last-response', handler)
    return () => { ipcRenderer.removeListener('claude-last-response', handler) }
  },
  onClaudeWorkState: (callback: (sessionId: string, state: ClaudeWorkState) => void) => {
    const handler = (_event: any, sessionId: string, state: ClaudeWorkState) => callback(sessionId, state)
    ipcRenderer.on('claude-work-state', handler)
    return () => { ipcRenderer.removeListener('claude-work-state', handler) }
  },
  codexWatchSession: (sessionId: string, cwd: string, codexPid?: number) => {
    ipcRenderer.send('codex-watch-session', sessionId, cwd, codexPid)
  },
  codexUnwatchSession: (sessionId: string) => {
    ipcRenderer.send('codex-unwatch-session', sessionId)
  },
  onCodexLastResponse: (callback: (sessionId: string, text: string) => void) => {
    const handler = (_event: any, sessionId: string, text: string) => callback(sessionId, text)
    ipcRenderer.on('codex-last-response', handler)
    return () => { ipcRenderer.removeListener('codex-last-response', handler) }
  },
  onCodexWorkState: (callback: (sessionId: string, state: CodexWorkState) => void) => {
    const handler = (_event: any, sessionId: string, state: CodexWorkState) => callback(sessionId, state)
    ipcRenderer.on('codex-work-state', handler)
    return () => { ipcRenderer.removeListener('codex-work-state', handler) }
  },
  onIdleNotification: (callback: (notification: IdleNotification) => void) => {
    const handler = (_event: any, notification: IdleNotification) => callback(notification)
    ipcRenderer.on('idle-notification', handler)
    return () => { ipcRenderer.removeListener('idle-notification', handler) }
  },
  navigateToSession: (sessionId: string) => {
    ipcRenderer.send('set-active-session', sessionId)
  },
  onNavigateToSession: (callback: (sessionId: string) => void) => {
    const handler = (_event: any, sessionId: string) => callback(sessionId)
    ipcRenderer.on('navigate-to-session', handler)
    return () => { ipcRenderer.removeListener('navigate-to-session', handler) }
  },
  onSessionLabelUpdate: (callback: (sessionId: string, label: string) => void) => {
    const handler = (_event: any, sessionId: string, label: string) => callback(sessionId, label)
    ipcRenderer.on('session-label-update', handler)
    return () => { ipcRenderer.removeListener('session-label-update', handler) }
  },
  onCloseActiveSession: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('close-active-session', handler)
    return () => { ipcRenderer.removeListener('close-active-session', handler) }
  },
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('terminal-data')
    ipcRenderer.removeAllListeners('process-change')
    ipcRenderer.removeAllListeners('terminal-exit')
    ipcRenderer.removeAllListeners('terminal-snapshot')
    ipcRenderer.removeAllListeners('claude-last-response')
    ipcRenderer.removeAllListeners('claude-work-state')
    ipcRenderer.removeAllListeners('codex-last-response')
    ipcRenderer.removeAllListeners('codex-work-state')
    ipcRenderer.removeAllListeners('idle-notification')
    ipcRenderer.removeAllListeners('navigate-to-session')
    ipcRenderer.removeAllListeners('session-label-update')
    ipcRenderer.removeAllListeners('close-active-session')
  },
  getGitBranch: (cwd: string) => {
    return ipcRenderer.invoke('get-git-branch', cwd)
  },
  getGitDiffStat: (cwd: string) => {
    return ipcRenderer.invoke('get-git-diff-stat', cwd)
  },
  getGitDiffFiles: (cwd: string) => {
    return ipcRenderer.invoke('get-git-diff-files', cwd)
  },
  getGitFileDiff: (cwd: string, file: string) => {
    return ipcRenderer.invoke('get-git-file-diff', cwd, file)
  },
  runBackgroundCommand: (cwd: string, command: string) => {
    return ipcRenderer.invoke('run-background-command', cwd, command)
  },
  createWorktree: (repoDir: string, branch: string, worktreesDir: string) => {
    return ipcRenderer.invoke('create-worktree', repoDir, branch, worktreesDir)
  },
  removeWorktree: (mainRepoDir: string, worktreeDir: string) => {
    return ipcRenderer.invoke('remove-worktree', mainRepoDir, worktreeDir)
  },
  getSupersetWorktrees: (repoPath: string) => {
    return ipcRenderer.invoke('get-superset-worktrees', repoPath)
  },
  selectDirectory: () => {
    return ipcRenderer.invoke('select-directory')
  },
  selectFile: (filters?: { name: string; extensions: string[] }[]) => {
    return ipcRenderer.invoke('select-file', filters)
  },
  readFileAsDataUrl: (filePath: string) => {
    return ipcRenderer.invoke('read-file-as-data-url', filePath)
  },
  getListeningPorts: () => {
    return ipcRenderer.invoke('get-listening-ports')
  },
  killPort: (pid: number) => {
    return ipcRenderer.invoke('kill-port', pid)
  },
  saveState: (data) => {
    ipcRenderer.send('save-state', data)
  },
  getCodexDebugState: () => {
    return ipcRenderer.invoke('get-codex-debug-state')
  },
  getSessionsMemory: () => {
    return ipcRenderer.invoke('get-sessions-memory')
  },
  getPromptHistory: (sessionId: string) => {
    return ipcRenderer.invoke('get-prompt-history', sessionId)
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
