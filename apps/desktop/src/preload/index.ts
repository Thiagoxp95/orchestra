// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron'
import type {
  ElectronAPI,
  CreateTerminalOpts,
  CreateTerminalResult,
  ProcessStatus,
  WriteSource,
  IdleNotification,
  RepositoryWorkspaceSettings,
  AutomationRun,
  SkillEntry,
  UpdateStatus,
} from '../shared/types'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'

const api: ElectronAPI = {
  createTerminal: (sessionId: string, opts: CreateTerminalOpts): Promise<CreateTerminalResult> => {
    return ipcRenderer.invoke('terminal-create', sessionId, opts)
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
  onNormalizedAgentState: (callback: (status: NormalizedAgentSessionStatus) => void) => {
    const handler = (_event: any, status: NormalizedAgentSessionStatus) => callback(status)
    ipcRenderer.on('normalized-agent-state', handler)
    return () => { ipcRenderer.removeListener('normalized-agent-state', handler) }
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
  claudeSessionStarted: (sessionId: string) => {
    ipcRenderer.send('claude-session-started', sessionId)
  },
  claudeInterruptHint: (sessionId: string) => {
    ipcRenderer.send('claude-interrupt-hint', sessionId)
  },
  codexWatchSession: (sessionId: string, cwd: string, codexPid?: number) => {
    ipcRenderer.send('codex-watch-session', sessionId, cwd, codexPid)
  },
  codexUnwatchSession: (sessionId: string) => {
    ipcRenderer.send('codex-unwatch-session', sessionId)
  },
  codexSessionStarted: (sessionId: string) => {
    ipcRenderer.send('codex-session-started', sessionId)
  },
  onTerminalLastOutput: (callback: (sessionId: string, text: string) => void) => {
    const handler = (_event: any, sessionId: string, text: string) => callback(sessionId, text)
    ipcRenderer.on('terminal-last-output', handler)
    return () => { ipcRenderer.removeListener('terminal-last-output', handler) }
  },
  onIdleNotification: (callback: (notification: IdleNotification) => void) => {
    const handler = (_event: any, notification: IdleNotification) => callback(notification)
    ipcRenderer.on('idle-notification', handler)
    return () => { ipcRenderer.removeListener('idle-notification', handler) }
  },
  onIdleNotificationSummaryUpdate: (callback: (update: { sessionId: string; title: string }) => void) => {
    const handler = (_event: any, update: { sessionId: string; title: string }) => callback(update)
    ipcRenderer.on('idle-notification-summary-update', handler)
    return () => { ipcRenderer.removeListener('idle-notification-summary-update', handler) }
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
  showEmojiPanel: () => {
    ipcRenderer.send('show-emoji-panel')
  },
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('terminal-data')
    ipcRenderer.removeAllListeners('process-change')
    ipcRenderer.removeAllListeners('terminal-exit')
    ipcRenderer.removeAllListeners('terminal-snapshot')
    ipcRenderer.removeAllListeners('terminal-last-output')
    ipcRenderer.removeAllListeners('idle-notification')
    ipcRenderer.removeAllListeners('idle-notification-summary-update')
    ipcRenderer.removeAllListeners('navigate-to-session')
    ipcRenderer.removeAllListeners('session-label-update')
    ipcRenderer.removeAllListeners('close-active-session')
    ipcRenderer.removeAllListeners('automation-run-result')
    ipcRenderer.removeAllListeners('automation-run-output')
    ipcRenderer.removeAllListeners('automation-schedule-sync')
    ipcRenderer.removeAllListeners('automation-disabled')
    ipcRenderer.removeAllListeners('webhook-run-action')
    ipcRenderer.removeAllListeners('webhook-event-notification')
    ipcRenderer.removeAllListeners('update-status')
    ipcRenderer.removeAllListeners('usage-update')
  },
  getGitBranch: (cwd: string) => {
    return ipcRenderer.invoke('get-git-branch', cwd)
  },
  getGitPRInfo: (cwd: string, branch: string) => {
    return ipcRenderer.invoke('get-git-pr-info', cwd, branch)
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
  scanWorktreesDir: (repoDir: string, worktreesDir: string) => {
    return ipcRenderer.invoke('scan-worktrees-dir', repoDir, worktreesDir)
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
  requestTerminalSnapshot: (sessionId: string, dims?: { cols: number; rows: number }) => {
    return ipcRenderer.invoke('terminal-snapshot-request', sessionId, dims?.cols, dims?.rows)
  },
  getClaudeDebugState: () => {
    return ipcRenderer.invoke('get-claude-debug-state')
  },
  getWorkStateDebugSnapshot: (lineCount?: number) => {
    return ipcRenderer.invoke('get-work-state-debug-snapshot', lineCount)
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
  },
  onAutomationRunResult: (callback: (run: AutomationRun) => void) => {
    const handler = (_event: any, run: AutomationRun) => callback(run)
    ipcRenderer.on('automation-run-result', handler)
    return () => { ipcRenderer.removeListener('automation-run-result', handler) }
  },
  onAutomationRunOutput: (callback: (data: { actionId: string; chunk: string }) => void) => {
    const handler = (_event: any, data: { actionId: string; chunk: string }) => callback(data)
    ipcRenderer.on('automation-run-output', handler)
    return () => { ipcRenderer.removeListener('automation-run-output', handler) }
  },
  onAutomationScheduleSync: (callback: (data: Record<string, number>) => void) => {
    const handler = (_event: any, data: Record<string, number>) => callback(data)
    ipcRenderer.on('automation-schedule-sync', handler)
    return () => { ipcRenderer.removeListener('automation-schedule-sync', handler) }
  },
  getAutomationRuns: (actionId: string) => {
    return ipcRenderer.invoke('automation-get-runs', actionId)
  },
  runAutomationNow: (workspaceId: string, actionId: string) => {
    return ipcRenderer.invoke('automation-run-now', workspaceId, actionId)
  },
  cancelAutomation: (actionId: string) => {
    return ipcRenderer.invoke('automation-cancel', actionId)
  },
  automationActionDeleted: (actionId: string) => {
    ipcRenderer.send('automation-action-deleted', actionId)
  },
  onAutomationDisabled: (callback: (actionId: string) => void) => {
    const handler = (_event: any, actionId: string) => callback(actionId)
    ipcRenderer.on('automation-disabled', handler)
    return () => { ipcRenderer.removeListener('automation-disabled', handler) }
  },
  getAutomationDebugState: () => {
    return ipcRenderer.invoke('automation-debug-state')
  },

  // Webhooks
  webhookEnable: (workspaceId: string, actionId: string, actionName: string, filter?: string) => {
    return ipcRenderer.invoke('webhook-enable', workspaceId, actionId, actionName, filter)
  },
  webhookDisable: (workspaceId: string, actionId: string, token: string) => {
    return ipcRenderer.invoke('webhook-disable', workspaceId, actionId, token)
  },
  webhookUpdateFilter: (token: string, filter?: string) => {
    return ipcRenderer.invoke('webhook-update-filter', token, filter)
  },
  onWebhookRunAction: (callback: (data: { workspaceId: string; actionId: string }) => void) => {
    const handler = (_event: any, data: { workspaceId: string; actionId: string }) => callback(data)
    ipcRenderer.on('webhook-run-action', handler)
    return () => { ipcRenderer.removeListener('webhook-run-action', handler) }
  },
  onWebhookEventNotification: (callback: (data: import('../shared/types').WebhookEventToast) => void) => {
    const handler = (_event: any, data: import('../shared/types').WebhookEventToast) => callback(data)
    ipcRenderer.on('webhook-event-notification', handler)
    return () => { ipcRenderer.removeListener('webhook-event-notification', handler) }
  },

  // Skills
  scanSkills: (rootDir: string): Promise<SkillEntry[]> => {
    return ipcRenderer.invoke('skills-scan', rootDir)
  },
  getSkillContent: (filePath: string): Promise<string | null> => {
    return ipcRenderer.invoke('skill-content', filePath)
  },

  // Auto-update
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => {
    const handler = (_event: any, status: UpdateStatus) => callback(status)
    ipcRenderer.on('update-status', handler)
    return () => { ipcRenderer.removeListener('update-status', handler) }
  },
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status') as Promise<UpdateStatus | null>,

  // Usage tracking
  getUsageSnapshot: () => ipcRenderer.invoke('get-usage-snapshot'),
  onUsageUpdate: (callback: (snapshot: any) => void) => {
    const handler = (_event: any, snapshot: any) => callback(snapshot)
    ipcRenderer.on('usage-update', handler)
    return () => { ipcRenderer.removeListener('usage-update', handler) }
  },
  refreshUsage: () => ipcRenderer.invoke('refresh-usage'),

  // Linear safe storage
  linearEncryptKey: (rawKey: string): Promise<string> => {
    return ipcRenderer.invoke('linear:encrypt-key', rawKey)
  },
  linearDecryptKey: (encryptedKey: string): Promise<string> => {
    return ipcRenderer.invoke('linear:decrypt-key', encryptedKey)
  },
  interruptionModeChanged: (workspaceId: string, enabled: boolean) => {
    ipcRenderer.send('interruption-mode-changed', workspaceId, enabled)
  },
  dismissInterruptionPopup: (sessionId: string) => {
    ipcRenderer.send('dismiss-interruption-popup', sessionId)
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)
