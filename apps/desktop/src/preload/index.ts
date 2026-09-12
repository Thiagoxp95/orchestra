// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron'
import type {
  ElectronAPI,
  AgentChatLogEvent,
  AgentChatRow,
  AgentContextInfo,
  AgentKeyStep,
  AgentSlashCommand,
  ClaudeWorkState,
  CreateTerminalOpts,
  CreateTerminalResult,
  ProcessStatus,
  RecentAgentSession,
  WriteSource,
  IdleNotification,
  RepositoryWorkspaceSettings,
  AutomationRun,
  SkillEntry,
  UpdateStatus,
  VoiceEvent,
  VoiceSettings,
  VoiceSetupProgressEvent,
  VoiceSetupStatus,
  VoiceStatus,
  ResumableAgent,
  VoiceVocabularyEntry,
} from '../shared/types'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'
import type { NativeChatSnapshot } from '../shared/native-chat'

const api: ElectronAPI = {
  nativeChatGet: (sessionId) => ipcRenderer.invoke('native-chat-get', sessionId),
  nativeChatList: () => ipcRenderer.invoke('native-chat-list'),
  nativeChatCommand: (sessionId, command) => ipcRenderer.invoke('native-chat-command', sessionId, command),
  onNativeChatState: (callback) => {
    const handler = (_event: unknown, snapshot: NativeChatSnapshot) => callback(snapshot)
    ipcRenderer.on('native-chat-state', handler)
    return () => { ipcRenderer.removeListener('native-chat-state', handler) }
  },
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
  // Reclaim geometry ownership for the desktop (user clicked/opened a session on
  // the computer). Optionally hand the active terminal's geometry so the bridge
  // can resize every open PTY back to it.
  remoteClaimDesktop: (cols?: number, rows?: number, sessionId?: string) => {
    ipcRenderer.send('remote-claim-desktop', cols, rows, sessionId)
  },
  writeTerminal: (sessionId: string, data: string, source: WriteSource = 'user') => {
    ipcRenderer.send('terminal-write', sessionId, data, source)
  },
  onTerminalData: (callback: (sessionId: string, data: string) => void) => {
    const handler = (_event: any, sessionId: string, data: string) => callback(sessionId, data)
    ipcRenderer.on('terminal-data', handler)
    return () => { ipcRenderer.removeListener('terminal-data', handler) }
  },
  // ── Chat view ─────────────────────────────────────────────────────────────
  // Reads the main process's own parsed-transcript log (agent-chat-log.ts), the
  // local twin of what the phone pulls from Convex.
  chatSince: (sessionId: string, afterSeq: number): Promise<AgentChatRow[]> => {
    return ipcRenderer.invoke('chat-since', sessionId, afterSeq)
  },
  chatBefore: (sessionId: string, beforeSeq: number, limit: number): Promise<AgentChatRow[]> => {
    return ipcRenderer.invoke('chat-before', sessionId, beforeSeq, limit)
  },
  onChatLogEvent: (callback: (event: AgentChatLogEvent) => void) => {
    const handler = (_event: any, payload: AgentChatLogEvent) => callback(payload)
    ipcRenderer.on('chat-log-event', handler)
    return () => { ipcRenderer.removeListener('chat-log-event', handler) }
  },
  chatAgentContext: (): Promise<Record<string, AgentContextInfo>> => {
    return ipcRenderer.invoke('chat-agent-context')
  },
  // Sessions whose transcript is being read — the ones with a chat to show.
  chatReadySessions: (): Promise<string[]> => {
    return ipcRenderer.invoke('chat-ready-sessions')
  },
  onChatReadySessions: (callback: (sessionIds: string[]) => void) => {
    const handler = (_event: any, sessionIds: string[]) => callback(sessionIds)
    ipcRenderer.on('chat-ready-sessions', handler)
    return () => { ipcRenderer.removeListener('chat-ready-sessions', handler) }
  },
  // The conversation each agent pane is holding, as the main process resolves
  // it. Persisted on the session row so a pane can resume itself after a reboot.
  onSessionResumePairing: (
    callback: (sessionId: string, pairing: { agent: ResumableAgent; resumeSessionId: string }) => void,
  ) => {
    const handler = (_event: any, sessionId: string, pairing: { agent: ResumableAgent; resumeSessionId: string }) =>
      callback(sessionId, pairing)
    ipcRenderer.on('session-resume-pairing', handler)
    return () => { ipcRenderer.removeListener('session-resume-pairing', handler) }
  },
  // The phone asked a pane to reopen its own conversation (remote-resume-session).
  onRemoteResumeSession: (callback: (payload: { sessionId: string }) => void) => {
    const handler = (_event: any, payload: { sessionId: string }) => callback(payload)
    ipcRenderer.on('remote-resume-session', handler)
    return () => { ipcRenderer.removeListener('remote-resume-session', handler) }
  },
  // Sessions whose PTY is gone — the ones a resume can be offered on.
  exitedSessions: (): Promise<string[]> => {
    return ipcRenderer.invoke('exited-sessions')
  },
  onExitedSessions: (callback: (sessionIds: string[]) => void) => {
    const handler = (_event: any, sessionIds: string[]) => callback(sessionIds)
    ipcRenderer.on('exited-sessions', handler)
    return () => { ipcRenderer.removeListener('exited-sessions', handler) }
  },
  chatSlashCommands: (
    workspaceId: string,
    agent?: 'claude' | 'codex',
  ): Promise<AgentSlashCommand[]> => {
    return ipcRenderer.invoke('chat-slash-commands', workspaceId, agent)
  },
  chatSaveImage: (bytes: Uint8Array, mime: string): Promise<string> => {
    return ipcRenderer.invoke('chat-save-image', bytes, mime)
  },
  chatKeySteps: (sessionId: string, steps: AgentKeyStep[]): Promise<boolean> => {
    return ipcRenderer.invoke('chat-key-steps', sessionId, steps)
  },
  chatSubmit: (sessionId: string, body: string, opts?: { steer?: boolean; before?: AgentKeyStep[] }): Promise<void> => {
    return ipcRenderer.invoke('chat-submit', sessionId, body, opts)
  },
  chatInterrupt: (sessionId: string): Promise<void> => ipcRenderer.invoke('chat-interrupt', sessionId),
  onProcessChange: (callback: (sessionId: string, status: ProcessStatus, aiPid?: number) => void) => {
    ipcRenderer.on('process-change', (_event, sessionId, status, aiPid) => callback(sessionId, status, aiPid))
  },
  onNormalizedAgentState: (callback: (status: NormalizedAgentSessionStatus) => void) => {
    const handler = (_event: any, status: NormalizedAgentSessionStatus) => callback(status)
    ipcRenderer.on('normalized-agent-state', handler)
    return () => { ipcRenderer.removeListener('normalized-agent-state', handler) }
  },
  onClaudeWorkStateChange: (callback: (sessionId: string, state: ClaudeWorkState) => void) => {
    const handler = (_event: any, sessionId: string, state: ClaudeWorkState) => callback(sessionId, state)
    ipcRenderer.on('claude-work-state', handler)
    return () => { ipcRenderer.removeListener('claude-work-state', handler) }
  },
  getClaudeWorkState: (sessionId: string): Promise<ClaudeWorkState | null> => {
    return ipcRenderer.invoke('get-claude-work-state', sessionId)
  },
  getNormalizedAgentState: (sessionId: string): Promise<NormalizedAgentSessionStatus | null> => {
    return ipcRenderer.invoke('get-normalized-agent-state', sessionId)
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
    ipcRenderer.removeAllListeners('normalized-agent-state')
    ipcRenderer.removeAllListeners('claude-work-state')
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
    ipcRenderer.removeAllListeners('remote-run-action')
    ipcRenderer.removeAllListeners('remote-create-worktree')
    ipcRenderer.removeAllListeners('remote-spawn-in-tree')
    ipcRenderer.removeAllListeners('remote-remove-worktree')
    ipcRenderer.removeAllListeners('remote-resume-agent-session')
    ipcRenderer.removeAllListeners('remote-kill-session')
    ipcRenderer.removeAllListeners('remote-set-session-pinned')
    ipcRenderer.removeAllListeners('remote-rename-session')
    ipcRenderer.removeAllListeners('remote-acknowledge-attention')
    ipcRenderer.removeAllListeners('webhook-event-notification')
    ipcRenderer.removeAllListeners('update-status')
    ipcRenderer.removeAllListeners('usage-update')
  },
  getGitBranch: (cwd: string) => {
    return ipcRenderer.invoke('get-git-branch', cwd)
  },
  renameGitBranch: (cwd: string, newName: string) => {
    return ipcRenderer.invoke('rename-git-branch', cwd, newName)
  },
  runHeadlessAgent: (cwd: string, prompt: string) => {
    return ipcRenderer.invoke('run-headless-agent', cwd, prompt)
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
  removeWorktree: (mainRepoDir: string, worktreeDir: string, options?: { skipBackup?: boolean }) => {
    return ipcRenderer.invoke('remove-worktree', mainRepoDir, worktreeDir, options)
  },
  backupWorktree: (mainRepoDir: string, worktreeDir: string) => {
    return ipcRenderer.invoke('backup-worktree', mainRepoDir, worktreeDir)
  },
  listWorktreeBackups: (mainRepoDir?: string) => {
    return ipcRenderer.invoke('list-worktree-backups', mainRepoDir)
  },
  restoreWorktreeBackup: (backupId: string) => {
    return ipcRenderer.invoke('restore-worktree-backup', backupId)
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
  getRunningServers: () => {
    return ipcRenderer.invoke('get-running-servers')
  },
  killRunningServer: (pid: number, port: number) => {
    return ipcRenderer.invoke('kill-running-server', pid, port)
  },
  openExternalUrl: (url: string) => {
    return ipcRenderer.invoke('open-external-url', url)
  },
  requestTerminalSnapshot: (sessionId: string, dims?: { cols: number; rows: number }) => {
    return ipcRenderer.invoke('terminal-snapshot-request', sessionId, dims?.cols, dims?.rows)
  },
  getWorkStateDebugSnapshot: (lineCount?: number) => {
    return ipcRenderer.invoke('get-work-state-debug-snapshot', lineCount)
  },
  saveState: (data) => {
    ipcRenderer.send('save-state', data)
  },
  // Realtime mirror to the remote bridge, decoupled from the debounced disk
  // save above so a spawned/closed session reaches a phone/web client at once
  // instead of waiting out the save-state debounce. See App.tsx (createThrottle)
  // and remote-bridge.ts (remoteBridgeOnMirror).
  mirrorState: (data) => {
    ipcRenderer.send('mirror-state', data)
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
  onRemoteRunAction: (callback: (data: { workspaceId: string; actionId: string }) => void) => {
    const handler = (_event: any, data: { workspaceId: string; actionId: string }) => callback(data)
    ipcRenderer.on('remote-run-action', handler)
    return () => { ipcRenderer.removeListener('remote-run-action', handler) }
  },
  onRemoteCreateWorktree: (
    callback: (data: {
      workspaceId: string
      branch: string
      selectedActionIds: string[]
      spinUp: 'terminal' | 'claude' | 'codex' | 'cursor' | null
    }) => void,
  ) => {
    const handler = (
      _event: any,
      data: {
        workspaceId: string
        branch: string
        selectedActionIds: string[]
        spinUp: 'terminal' | 'claude' | 'codex' | 'cursor' | null
      },
    ) => callback(data)
    ipcRenderer.on('remote-create-worktree', handler)
    return () => {
      ipcRenderer.removeListener('remote-create-worktree', handler)
    }
  },
  onRemoteSpawnInTree: (
    callback: (data: {
      workspaceId: string
      treeIndex: number
      agent: 'terminal' | 'claude' | 'codex' | 'cursor' | null
      actionId: string | null
    }) => void,
  ) => {
    const handler = (
      _event: any,
      data: {
        workspaceId: string
        treeIndex: number
        agent: 'terminal' | 'claude' | 'codex' | 'cursor' | null
        actionId: string | null
      },
    ) => callback(data)
    ipcRenderer.on('remote-spawn-in-tree', handler)
    return () => {
      ipcRenderer.removeListener('remote-spawn-in-tree', handler)
    }
  },
  onRemoteResumeAgentSession: (
    callback: (data: { agent: 'claude' | 'codex'; sessionId: string; cwd: string }) => void,
  ) => {
    const handler = (
      _event: any,
      data: { agent: 'claude' | 'codex'; sessionId: string; cwd: string },
    ) => callback(data)
    ipcRenderer.on('remote-resume-agent-session', handler)
    return () => {
      ipcRenderer.removeListener('remote-resume-agent-session', handler)
    }
  },
  onRemoteRemoveWorktree: (callback: (data: { workspaceId: string; treeIndex: number }) => void) => {
    const handler = (_event: any, data: { workspaceId: string; treeIndex: number }) => callback(data)
    ipcRenderer.on('remote-remove-worktree', handler)
    return () => {
      ipcRenderer.removeListener('remote-remove-worktree', handler)
    }
  },
  onRemoteKillSession: (callback: (sessionId: string) => void) => {
    const handler = (_event: any, sessionId: string) => callback(sessionId)
    ipcRenderer.on('remote-kill-session', handler)
    return () => { ipcRenderer.removeListener('remote-kill-session', handler) }
  },
  // Phone pinned/unpinned a session, or typed it a title. Both are store fields
  // the next state push mirrors straight back, so the phone's own row updates
  // from the round trip rather than optimistically.
  onRemoteSetSessionPinned: (callback: (data: { sessionId: string; pinned: boolean }) => void) => {
    const handler = (_event: any, data: { sessionId: string; pinned: boolean }) => callback(data)
    ipcRenderer.on('remote-set-session-pinned', handler)
    return () => { ipcRenderer.removeListener('remote-set-session-pinned', handler) }
  },
  onRemoteRenameSession: (callback: (data: { sessionId: string; title: string }) => void) => {
    const handler = (_event: any, data: { sessionId: string; title: string }) => callback(data)
    ipcRenderer.on('remote-rename-session', handler)
    return () => { ipcRenderer.removeListener('remote-rename-session', handler) }
  },
  // Phone focused or typed into a session; clear its "needs input" flag like a
  // desktop focus/keystroke would.
  onRemoteAcknowledgeAttention: (callback: (sessionId: string) => void) => {
    const handler = (_event: any, sessionId: string) => callback(sessionId)
    ipcRenderer.on('remote-acknowledge-attention', handler)
    return () => { ipcRenderer.removeListener('remote-acknowledge-attention', handler) }
  },
  // Geometry ownership changed. owner 'web' → a focused phone claimed the PTY
  // size (cols/rows given); the desktop should stop auto-fitting and scale to
  // view. owner 'desktop' → the desktop drives again and re-fits normally.
  onRemoteGeometryOwner: (
    callback: (data: { owner: 'desktop' | 'web'; cols?: number; rows?: number; epoch: number; sessionId?: string }) => void,
  ) => {
    const handler = (
      _event: any,
      data: { owner: 'desktop' | 'web'; cols?: number; rows?: number; epoch: number; sessionId?: string },
    ) => callback(data)
    ipcRenderer.on('remote-geometry-owner', handler)
    return () => { ipcRenderer.removeListener('remote-geometry-owner', handler) }
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

  // Recent Claude/Codex sessions (resume after an accidental quit)
  listRecentAgentSessions: (opts?: { limit?: number; maxAgeDays?: number }): Promise<RecentAgentSession[]> => {
    return ipcRenderer.invoke('agent-sessions-recent', opts)
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
  refreshUsage: (providerId) => ipcRenderer.invoke('refresh-usage', providerId),
  getUsageBackgroundSync: () => ipcRenderer.invoke('get-usage-bg-sync'),
  setUsageBackgroundSync: (settings) => ipcRenderer.invoke('set-usage-bg-sync', settings),

  // Linear safe storage
  linearEncryptKey: (rawKey: string): Promise<string> => {
    return ipcRenderer.invoke('linear:encrypt-key', rawKey)
  },
  linearDecryptKey: (encryptedKey: string): Promise<string> => {
    return ipcRenderer.invoke('linear:decrypt-key', encryptedKey)
  },
  openRouterEncryptKey: (rawKey: string): Promise<string> => {
    return ipcRenderer.invoke('openrouter:encrypt-key', rawKey)
  },
  openRouterDecryptKey: (encryptedKey: string): Promise<string> => {
    return ipcRenderer.invoke('openrouter:decrypt-key', encryptedKey)
  },
  openRouterListModels: (apiKey?: string): Promise<{ id: string; name: string }[]> => {
    return ipcRenderer.invoke('openrouter:list-models', apiKey)
  },
  interruptionModeChanged: (workspaceId: string, enabled: boolean) => {
    ipcRenderer.send('interruption-mode-changed', workspaceId, enabled)
  },
  dismissInterruptionPopup: (sessionId: string) => {
    ipcRenderer.send('dismiss-interruption-popup', sessionId)
  },

  openExternalPath: (p: string): Promise<void> => {
    return ipcRenderer.invoke('open-external-path', p)
  },

  // Voice wake-word control
  voiceEnable: (): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('voice:enable')
  },
  voiceDisable: (): Promise<void> => {
    return ipcRenderer.invoke('voice:disable')
  },
  voiceSetVocabulary: (vocab: VoiceVocabularyEntry[]): void => {
    ipcRenderer.send('voice:setVocabulary', vocab)
  },
  voiceUpdateSettings: (settings: VoiceSettings): Promise<void> => {
    return ipcRenderer.invoke('voice:updateSettings', settings)
  },
  voiceGetStatus: (): Promise<VoiceStatus> => {
    return ipcRenderer.invoke('voice:getStatus')
  },
  voiceGetLogs: (): Promise<string[]> => {
    return ipcRenderer.invoke('voice:getLogs')
  },
  onVoiceEvent: (callback: (event: VoiceEvent) => void) => {
    const handler = (_event: any, data: VoiceEvent) => callback(data)
    ipcRenderer.on('voice:event', handler)
    return () => { ipcRenderer.removeListener('voice:event', handler) }
  },
  onVoiceStatus: (callback: (status: VoiceStatus) => void) => {
    const handler = (_event: any, data: VoiceStatus) => callback(data)
    ipcRenderer.on('voice:status', handler)
    return () => { ipcRenderer.removeListener('voice:status', handler) }
  },
  voiceCheckSetup: (): Promise<VoiceSetupStatus> => {
    return ipcRenderer.invoke('voice:checkSetup')
  },
  voiceRunSetup: (opts?: { installPython?: boolean }): Promise<VoiceSetupStatus> => {
    return ipcRenderer.invoke('voice:runSetup', opts ?? {})
  },
  onVoiceSetupProgress: (callback: (event: VoiceSetupProgressEvent) => void) => {
    const handler = (_event: any, data: VoiceSetupProgressEvent) => callback(data)
    ipcRenderer.on('voice:setupProgress', handler)
    return () => { ipcRenderer.removeListener('voice:setupProgress', handler) }
  },
  voiceGetIntroSeen: (): Promise<boolean> => {
    return ipcRenderer.invoke('voice:getIntroSeen')
  },
  voiceMarkIntroSeen: (): Promise<void> => {
    return ipcRenderer.invoke('voice:markIntroSeen')
  },
  voiceGetSetupAttempted: (): Promise<boolean> => {
    return ipcRenderer.invoke('voice:getSetupAttempted')
  },
  voiceSetSetupAttempted: (attempted: boolean): Promise<void> => {
    return ipcRenderer.invoke('voice:setSetupAttempted', attempted)
  },
  voiceGetSetupCardDismissed: (): Promise<boolean> => {
    return ipcRenderer.invoke('voice:getSetupCardDismissed')
  },
  voiceSetSetupCardDismissed: (dismissed: boolean): Promise<void> => {
    return ipcRenderer.invoke('voice:setSetupCardDismissed', dismissed)
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)
