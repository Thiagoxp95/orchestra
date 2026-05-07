// src/shared/types.ts

import type { AgentControlsConfig } from './agent-controls'
import type { NormalizedAgentSessionStatus } from './agent-session-types'

export interface WorkspaceTree {
  rootDir: string
  sessionIds: string[]
  displayName?: string
}

export interface WorkspaceRepositorySettings {
  enabled: boolean
}

export interface Workspace {
  id: string
  name: string
  color: string
  emoji?: string
  trees: WorkspaceTree[]
  activeTreeIndex: number
  lastActiveSessionId?: string | null
  customActions: CustomAction[]
  repositorySettings?: WorkspaceRepositorySettings
  createdAt: number
  notificationSound?: string // absolute path to custom mp3, undefined = default
  questionNotificationSound?: string // absolute path to custom mp3 for input-needed alerts
  viewMode?: 'orchestrator' | 'board'
  linearConfig?: {
    apiKey: string   // encrypted via safeStorage, stored as base64
    teamId: string
    teamName: string
    filters?: {
      assigneeIds?: string[]
      labelIds?: string[]
      stateIds?: string[]
    }
    importIntervalMinutes?: number // default 30
    statusMapping?: Record<string, string> // Linear state name → Orchestra status or 'skip'
  }
  interruptionMode?: boolean
  interruptionPosition?: InterruptionPosition
}

export type InterruptionPosition = 'bottom-left' | 'bottom-right' | { x: number; y: number }

export interface TerminalSession {
  id: string
  workspaceId: string
  label: string
  processStatus: ProcessStatus
  cwd: string
  shellPath: string
  initialCommand?: string
  launchProfile?: TerminalLaunchProfile
  actionId?: string
  actionIcon?: string
}

export type ProcessStatus = 'terminal' | 'claude' | 'codex' | 'cursor'

export type ActionType = 'cli' | 'claude' | 'codex' | 'cursor'
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
  printMode?: boolean
  isDefault?: boolean
  schedule?: AutomationSchedule
  automationEnabled?: boolean
  persistWhenClosed?: boolean
  automationTargetTreeIndex?: number
  webhookToken?: string
  webhookUrl?: string
  webhookFilter?: string // plain-English condition for LLM-based payload filtering
  voiceAliases?: string[] // optional voice phrases that map to this action; action name is always implicit
}

// Automation schedule — discriminated union by mode
export type AutomationSchedule =
  | { mode: 'daily'; time: string; days: number[] }
  | { mode: 'interval'; intervalMinutes: number; days: number[] }
  | { mode: 'cron'; cronExpression: string }

// Days convention: 1=Mon, 7=Sun (ISO 8601)
// Conversion: isoDay = jsDay === 0 ? 7 : jsDay

export interface AutomationRun {
  id: string
  actionId: string
  workspaceId: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'success' | 'error'
  output: string
  exitCode?: number
  errorMessage?: string
  triggeredBy: 'schedule' | 'manual' | 'webhook'
}

export interface AutomationSchedulerEntry {
  nextRunAt: number
  lastRunAt: number
}

// openWakeWord ships exactly these prebuilt models. "computer" was incorrectly
// listed earlier — no such prebuilt exists, and selecting it crashed the
// sidecar at startup.
export type VoiceWakeWord = 'hey jarvis' | 'alexa' | 'hey mycroft' | 'hey rhasspy'

export const VOICE_WAKE_WORDS: VoiceWakeWord[] = [
  'hey jarvis',
  'alexa',
  'hey mycroft',
  'hey rhasspy',
]

export function normalizeVoiceWakeWord(value: unknown): VoiceWakeWord {
  if (typeof value === 'string' && (VOICE_WAKE_WORDS as string[]).includes(value)) {
    return value as VoiceWakeWord
  }
  return 'hey jarvis'
}

export interface VoiceSettings {
  /** Master switch for the voice feature. Default false (opt-in). */
  enabled: boolean
  /** Selected wake word (must be one of openWakeWord's prebuilts). */
  wakeWord: VoiceWakeWord
  /** openWakeWord activation threshold (0-1). Default 0.6. */
  wakeWordThreshold: number
  /** Fuzzy intent confidence threshold (0-1). Default 0.75. */
  intentConfidenceThreshold: number
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  wakeWord: 'hey jarvis',
  wakeWordThreshold: 0.6,
  intentConfidenceThreshold: 0.75,
}

export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4.1-mini'

export const DEFAULT_OPENROUTER_CLASSIFIER_PROMPT =
  'Decide whether the final assistant message is waiting for the user to respond. ' +
  'Return only JSON with title, summary, and requiresUserInput. ' +
  'requiresUserInput is true only when the assistant asks a question, requests a choice, asks for confirmation, asks for credentials/info, or says it cannot proceed without user input.'

export interface OpenRouterSettings {
  /** Encrypted via safeStorage, stored as base64. */
  encryptedApiKey?: string
  model: string
  /** System prompt used to classify whether the agent is waiting for user input. */
  classifierPrompt?: string
}

export interface AppSettings {
  worktreesDir: string
  notificationSoundsMuted?: boolean
  keybindingOverrides?: Record<string, string>
  agentFooterControls?: Partial<AgentControlsConfig>
  voice?: VoiceSettings
  openRouter?: OpenRouterSettings
}

/**
 * Vocabulary pushed to the Python sidecar. Each entry maps an action id to
 * one or more spoken phrases (the action name plus any voiceAliases).
 */
export interface VoiceVocabularyEntry {
  actionId: string
  phrases: string[]
}

/** Discriminated union of events emitted by the Python sidecar. */
export type VoiceEvent =
  | { type: 'wake'; ts?: number }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'matched'; actionId: string; text: string; confidence: number }
  | { type: 'no_match'; text: string }
  | { type: 'timeout' }
  | { type: 'idle' }
  | { type: 'heartbeat' }
  | { type: 'error'; code: VoiceErrorCode; message?: string }

export type VoiceErrorCode =
  | 'mic_denied'
  | 'mic_lost'
  | 'model_missing'
  | 'sidecar_crash'
  | 'sidecar_failed_to_spawn'
  | 'wedged'
  | 'unknown'

export interface VoiceStatus {
  enabled: boolean
  /** Coarse runtime state. */
  state: 'disabled' | 'starting' | 'listening' | 'restarting' | 'error'
  lastError?: { code: VoiceErrorCode; message?: string }
}

export type VoiceSetupStage =
  | 'unknown'
  | 'checking_python'
  | 'python_missing'
  | 'venv_missing'
  | 'installing_deps'
  | 'downloading_model'
  | 'ready'
  | 'failed'

export interface VoiceSetupStatus {
  stage: VoiceSetupStage
  message?: string
  /** 0..1 if known. */
  progress?: number
  /** e.g. 'no_brew' | 'pip_failed' | 'model_download_failed' | 'python_too_old'. */
  errorCode?: string
  canRetry: boolean
  /** True on `python_missing` if `brew` is detected and we can offer auto-install. */
  canInstallPython: boolean
}

export interface VoiceSetupProgressEvent {
  stage: VoiceSetupStage
  message: string
  progress?: number
}

export interface RepositoryWorkspaceSettings {
  version: 1
  color?: string
  customActions?: CustomAction[]
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
export type CodexWorkState = 'idle' | 'working' | 'waitingApproval' | 'waitingUserInput'

export interface CodexWatcherDebugState {
  sessionId: string
  cwd: string
  lastWorkState: CodexWorkState
  // v1.11+ rollout-watcher fields. Optional for back-compat with older
  // renderers reading from the legacy IPC shape.
  transcriptPath?: string
  fileExists?: boolean
  lastEventAt?: string | null
  source?: 'rollout' | 'hook'
}

export interface WorkStateDebugSnapshot {
  path: string
  exists: boolean
  sizeBytes: number
  truncated: boolean
  tail: string[]
}

export interface IdleNotification {
  sessionId: string
  title: string
  /** Display label for the session/sidebar item. Prefer this as the notification subject. */
  sessionTitle?: string
  description?: string
  agentType: 'claude' | 'codex' | 'cursor'
  requiresUserInput: boolean
  showToast?: boolean
  /** The raw user prompt that triggered this agent run. */
  lastUserPrompt?: string
  /** Raw last response from the agent — only populated in dev builds for debugging. */
  debugLastResponse?: string
}

export interface ShellLaunchProfile {
  kind: 'shell'
}

export interface ExecLaunchProfile {
  kind: 'exec'
  file: string
  args?: string[]
  env?: Record<string, string>
}

export type TerminalLaunchProfile = ShellLaunchProfile | ExecLaunchProfile

export type GitPRState = 'OPEN' | 'CLOSED' | 'MERGED' | 'DRAFT'

export interface GitPRInfo {
  number: number
  state: GitPRState
  title: string
  url: string
}

export interface SupersetWorktree {
  path: string
  branch: string
}

export interface CreateTerminalOpts {
  cwd: string
  shell?: string
  cols?: number
  rows?: number
  initialCommand?: string
  launchProfile?: TerminalLaunchProfile
}

export interface LiveTerminalSessionInfo {
  sessionId: string
  processSessionId?: string
  pid: number | null
  cwd: string
  isAlive: boolean
}

export interface LiveTerminalSessionStatusInfo extends LiveTerminalSessionInfo {
  status: ProcessStatus
  aiPid: number | null
}

export interface CreateTerminalResult {
  success: boolean
  restoredSnapshot?: boolean
  error?: string
}

export interface ElectronAPI {
  createTerminal: (sessionId: string, opts: CreateTerminalOpts) => Promise<CreateTerminalResult>
  prewarmTerminal: (opts: { cwd: string; cols?: number; rows?: number }) => void
  killTerminal: (sessionId: string) => void
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void
  writeTerminal: (sessionId: string, data: string, source?: WriteSource) => void
  onTerminalData: (callback: (sessionId: string, data: string) => void) => () => void
  onProcessChange: (callback: (sessionId: string, status: ProcessStatus, aiPid?: number) => void) => void
  onNormalizedAgentState: (callback: (status: NormalizedAgentSessionStatus) => void) => () => void
  onClaudeWorkStateChange: (callback: (sessionId: string, state: ClaudeWorkState) => void) => () => void
  getClaudeWorkState: (sessionId: string) => Promise<ClaudeWorkState | null>
  getNormalizedAgentState: (sessionId: string) => Promise<NormalizedAgentSessionStatus | null>
  onTerminalExit: (callback: (sessionId: string) => void) => void
  onTerminalSnapshot: (callback: (sessionId: string, snapshot: any) => void) => () => void
  captureScrollback: (sessionId: string) => Promise<string>
  getCwd: (sessionId: string) => Promise<string>
  getPersistedData: () => Promise<PersistedData | null>
  getRepositoryWorkspaceSettings: (rootDir: string) => Promise<RepositoryWorkspaceSettings | null>
  saveRepositoryWorkspaceSettings: (
    rootDir: string,
    settings: RepositoryWorkspaceSettings | null
  ) => Promise<{ success: boolean; error?: string }>
  listLiveSessions: () => Promise<LiveTerminalSessionInfo[]>
  listLiveSessionStatuses: () => Promise<LiveTerminalSessionStatusInfo[]>
  selectDirectory: () => Promise<string | null>
  selectFile: (filters?: { name: string; extensions: string[] }[]) => Promise<string | null>
  readFileAsDataUrl: (filePath: string) => Promise<string | null>
  codexWatchSession: (sessionId: string, cwd: string, codexPid?: number) => void
  codexUnwatchSession: (sessionId: string) => void
  codexSessionStarted: (sessionId: string) => void
  onTerminalLastOutput: (callback: (sessionId: string, text: string) => void) => () => void
  onIdleNotification: (callback: (notification: IdleNotification) => void) => () => void
  onIdleNotificationSummaryUpdate: (callback: (update: { sessionId: string; title: string }) => void) => () => void
  navigateToSession: (sessionId: string) => void
  onNavigateToSession: (callback: (sessionId: string) => void) => () => void
  onSessionLabelUpdate: (callback: (sessionId: string, label: string) => void) => () => void
  onCloseActiveSession: (callback: () => void) => () => void
  showEmojiPanel: () => void
  removeAllListeners: () => void
  getGitBranch: (cwd: string) => Promise<string | null>
  getGitPRInfo: (cwd: string, branch: string) => Promise<GitPRInfo | null>
  getGitDiffStat: (cwd: string) => Promise<{ added: number; removed: number } | null>
  getGitDiffFiles: (cwd: string) => Promise<{ file: string; added: number; removed: number; status: string }[]>
  getGitFileDiff: (cwd: string, file: string) => Promise<string>
  runBackgroundCommand: (cwd: string, command: string) => Promise<{ success: boolean; error?: string }>
  createWorktree: (repoDir: string, branch: string, worktreesDir: string) => Promise<{ success: boolean; path?: string; error?: string }>
  removeWorktree: (mainRepoDir: string, worktreeDir: string) => Promise<{ success: boolean; error?: string }>
  scanWorktreesDir: (repoDir: string, worktreesDir: string) => Promise<SupersetWorktree[]>
  getSupersetWorktrees: (repoPath: string) => Promise<SupersetWorktree[]>
  getListeningPorts: () => Promise<{ port: number; pid: number; sessionId: string }[]>
  killPort: (pid: number) => Promise<{ success: boolean; error?: string }>
  getCodexDebugState: () => Promise<CodexWatcherDebugState[]>
  getWorkStateDebugSnapshot: (lineCount?: number) => Promise<WorkStateDebugSnapshot>
  getSessionsMemory: () => Promise<Record<string, number>>
  getPromptHistory: (sessionId: string) => Promise<PromptRecord[]>
  requestTerminalSnapshot: (
    sessionId: string,
    dims?: { cols: number; rows: number }
  ) => Promise<{ rehydrateSequences?: string; snapshotAnsi?: string } | null>
  saveState: (data: {
    workspaces: Record<string, Workspace>
    sessions: Record<string, TerminalSession>
    activeWorkspaceId: string | null
    activeSessionId: string | null
    settings: AppSettings
    claudeLastResponse: Record<string, string>
    codexLastResponse: Record<string, string>
  }) => void

  // Automation
  onAutomationRunResult: (callback: (run: AutomationRun) => void) => () => void
  onAutomationRunOutput: (callback: (data: { actionId: string; chunk: string }) => void) => () => void
  onAutomationScheduleSync: (callback: (data: Record<string, number>) => void) => () => void
  getAutomationRuns: (actionId: string) => Promise<AutomationRun[]>
  runAutomationNow: (workspaceId: string, actionId: string) => Promise<void>
  cancelAutomation: (actionId: string) => Promise<void>
  automationActionDeleted: (actionId: string) => void
  onAutomationDisabled: (callback: (actionId: string) => void) => () => void
  getAutomationDebugState: () => Promise<any>

  // Webhooks
  webhookEnable: (workspaceId: string, actionId: string, actionName: string, filter?: string) => Promise<{ token: string; url: string }>
  webhookDisable: (workspaceId: string, actionId: string, token: string) => Promise<void>
  webhookUpdateFilter: (token: string, filter?: string) => Promise<void>
  onWebhookRunAction: (callback: (data: { workspaceId: string; actionId: string }) => void) => () => void
  onWebhookEventNotification: (callback: (data: WebhookEventToast) => void) => () => void

  // Skills
  scanSkills: (rootDir: string) => Promise<SkillEntry[]>
  getSkillContent: (filePath: string) => Promise<string | null>

  // Auto-update
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
  checkForUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  getUpdateStatus: () => Promise<UpdateStatus | null>

  // Usage tracking
  getUsageSnapshot: () => Promise<UsageSnapshot>
  onUsageUpdate: (callback: (snapshot: UsageSnapshot) => void) => () => void
  refreshUsage: (providerId?: UsageProviderId) => Promise<void>
  getUsageBackgroundSync: () => Promise<UsageBackgroundSyncSettings>
  setUsageBackgroundSync: (settings: UsageBackgroundSyncSettings) => Promise<void>

  // Linear safe storage
  linearEncryptKey: (rawKey: string) => Promise<string>
  linearDecryptKey: (encryptedKey: string) => Promise<string>
  openRouterEncryptKey: (rawKey: string) => Promise<string>
  openRouterDecryptKey: (encryptedKey: string) => Promise<string>
  openRouterListModels: (apiKey?: string) => Promise<{ id: string; name: string }[]>
  interruptionModeChanged: (workspaceId: string, enabled: boolean) => void
  dismissInterruptionPopup: (sessionId: string) => void

  openExternalPath: (p: string) => Promise<void>

  // Voice wake-word control
  voiceEnable: () => Promise<{ success: boolean; error?: string }>
  voiceDisable: () => Promise<void>
  voiceSetVocabulary: (vocab: VoiceVocabularyEntry[]) => void
  voiceUpdateSettings: (settings: VoiceSettings) => Promise<void>
  voiceGetStatus: () => Promise<VoiceStatus>
  voiceGetLogs: () => Promise<string[]>
  onVoiceEvent: (callback: (event: VoiceEvent) => void) => () => void
  onVoiceStatus: (callback: (status: VoiceStatus) => void) => () => void
  voiceCheckSetup: () => Promise<VoiceSetupStatus>
  voiceRunSetup: (opts?: { installPython?: boolean }) => Promise<VoiceSetupStatus>
  onVoiceSetupProgress: (callback: (event: VoiceSetupProgressEvent) => void) => () => void
  voiceGetIntroSeen: () => Promise<boolean>
  voiceMarkIntroSeen: () => Promise<void>
  voiceGetSetupAttempted: () => Promise<boolean>
  voiceSetSetupAttempted: (attempted: boolean) => Promise<void>
  voiceGetSetupCardDismissed: () => Promise<boolean>
  voiceSetSetupCardDismissed: (dismissed: boolean) => Promise<void>
}

export type SkillSource = 'claude-skill' | 'claude-command' | 'codex-skill' | 'claude-plugin'
export type SkillScope = 'project' | 'user'

export interface SkillEntry {
  id: string
  name: string
  description: string
  source: SkillSource
  scope: SkillScope
  filePath: string
}

export interface WebhookEventToast {
  actionName: string
  workspaceName: string
  workspaceColor: string
  status: 'pending' | 'filtered'
  payload: unknown
  filterPrompt?: string
  filterResult?: string
  filterPassed: boolean
  createdAt: number
}

// Auto-update
export type UpdateStatusType = 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateStatus {
  status: UpdateStatusType
  version?: string       // populated for: available, downloaded
  currentVersion?: string
  releaseName?: string
  releaseNotes?: string  // populated for: available
  releaseDate?: string
  releaseUrl?: string
  percent?: number       // populated for: downloading (0-100)
  message?: string       // populated for: error (friendly copy)
  detail?: string        // populated for: error (raw detail)
}

// Usage tracking
export interface RateWindow {
  usedPercent: number    // 0-100
  resetsAt: string | null // ISO date or human-readable
  resetText: string | null // pre-formatted "Resets in 23m" / "Resets in 2d 4h"
}

export interface UsageProbeResult {
  provider: 'claude' | 'codex'
  session: RateWindow | null
  weekly: RateWindow | null
  error: string | null
  updatedAt: number
}

export interface DailyTokenEntry {
  date: string // YYYY-MM-DD
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ModelTokenSummary {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  messageCount: number
}

export interface UsageScanResult {
  provider: 'claude' | 'codex'
  todayMessages: number
  todayTokensIn: number
  todayTokensOut: number
  todayCostEstimate: number // USD
  last30Days: DailyTokenEntry[]
  modelBreakdown: ModelTokenSummary[]
  updatedAt: number
}

export interface UsageProviderState {
  probe: UsageProbeResult | null
  scan: UsageScanResult | null
  /** True while a refresh is in flight for this provider. */
  isSyncing: boolean
}

export interface UsageSnapshot {
  claude: UsageProviderState
  codex: UsageProviderState
}

export type UsageProviderId = 'claude' | 'codex'

export interface UsageBackgroundSyncSettings {
  enabled: boolean
  intervalSeconds: number
}

export type {
  AgentSessionAuthority,
  AgentSessionState,
  NormalizedAgentSessionStatus,
} from './agent-session-types'
export { isAgentSessionState, isAgentSessionAuthority, createDefaultNormalizedStatus } from './agent-session-types'
