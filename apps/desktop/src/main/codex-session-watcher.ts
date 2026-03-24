import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { BrowserWindow } from 'electron'
import { cleanForDisplay } from './claude-activity-parser'
import { getCodexHookRuntimePaths, getCodexSessionLogPath, type CodexHookEventType } from './codex-hook-runtime'
import { findCodexRolloutByDirectory, doesCodexRolloutMatchPromptHints } from './codex-rollout-files'
import { parseCodexRolloutLines } from './codex-rollout-parser'
import { notifyIdleTransition } from './idle-notifier'
import { getLastMeaningfulText, getTerminalBufferText, hasRecentAgentBusyIndicator, hasRecentTerminalOutput } from './terminal-output-buffer'
import { debugWorkState } from './work-state-debug'
import { getCodexWatchRegistrationDecision, shouldAllowPromptlessCodexRolloutBinding } from './codex-watch-registration'
import { resolveAgentProcessSessionId } from './agent-session-aliases'
import { PromptHistoryWriter, sanitizePromptText } from '../daemon/prompt-history-writer'
import type { CodexWatcherDebugState } from '../shared/types'
import type { CodexWorkState } from './codex-thread-state'
import type { AgentSessionRegistry } from './agent-session-authority'

export type { CodexWorkState }

let agentRegistry: AgentSessionRegistry | null = null

export function setAgentSessionRegistryRef(r: AgentSessionRegistry | null): void {
  agentRegistry = r
}

interface SessionEntry {
  sessionId: string
  processSessionId: string
  cwd: string
  createdAt: number
  lifecycleState: CodexWorkState
  logPath: string
  nativeRolloutPath: string | null
  lastResponse: string
  lastUserPrompt: string
  lastWorkState: CodexWorkState
  codexPid: number | undefined
  lastLogSize: number
  lastLogMtimeMs: number
  lastNativeRolloutSize: number
  lastNativeRolloutMtimeMs: number
  pollInterval: ReturnType<typeof setInterval> | null
  lastHookEventAt: number | null
}

const sessions = new Map<string, SessionEntry>()
const pendingHookEvents = new Map<string, CodexHookEventType>()
const pendingLaunchStarts = new Set<string>()
const TERMINAL_IDLE_FALLBACK_DELAY_MS = 4_000
const RECENT_TERMINAL_BUSY_GRACE_MS = 12_000

let mainWindow: BrowserWindow | null = null

function getCodexRolloutsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.HOME || homedir(), '.codex', 'sessions')
}

function getProcessStartTimeMs(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'etimes='], { timeout: 3000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(null)
        return
      }

      const elapsedSeconds = Number.parseInt(stdout.trim(), 10)
      if (!Number.isFinite(elapsedSeconds)) {
        resolve(null)
        return
      }

      resolve(Date.now() - elapsedSeconds * 1000)
    })
  })
}

function readFileStat(filePath: string | null): { size: number; mtimeMs: number } | null {
  if (!filePath) return null
  try {
    const stat = fs.statSync(filePath)
    return { size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

function readRolloutSnapshot(filePath: string | null): ReturnType<typeof parseCodexRolloutLines> | null {
  if (!filePath) return null
  try {
    if (!fs.existsSync(filePath)) return null
    const text = fs.readFileSync(filePath, 'utf8')
    if (!text.trim()) return null
    return parseCodexRolloutLines(text.split('\n'))
  } catch {
    return null
  }
}

function resetLogTracking(entry: SessionEntry): void {
  entry.lastLogSize = 0
  entry.lastLogMtimeMs = 0
}

function resetNativeRolloutTracking(entry: SessionEntry): void {
  entry.nativeRolloutPath = null
  entry.lastNativeRolloutSize = 0
  entry.lastNativeRolloutMtimeMs = 0
}

function getSessionPromptHints(sessionId: string): string[] {
  const history = PromptHistoryWriter.readHistory(sessionId)
  const promptHints: string[] = []
  const seen = new Set<string>()

  for (let index = history.length - 1; index >= 0 && promptHints.length < 5; index--) {
    const text = sanitizePromptText(history[index]?.text ?? '')
    if (!text || seen.has(text)) continue
    seen.add(text)
    promptHints.push(text)
  }

  return promptHints
}

function getOtherSessionOwningNativeRollout(filePath: string, sessionId: string): string | null {
  for (const entry of sessions.values()) {
    if (entry.sessionId === sessionId) continue
    if (entry.nativeRolloutPath === filePath) {
      return entry.sessionId
    }
  }

  return null
}

function resolveNativeRolloutPath(entry: SessionEntry, promptHints: string[]): string | null {
  if (entry.nativeRolloutPath) {
    const owner = getOtherSessionOwningNativeRollout(entry.nativeRolloutPath, entry.sessionId)
    if (owner) {
      resetNativeRolloutTracking(entry)
    } else if (!fs.existsSync(entry.nativeRolloutPath)) {
      resetNativeRolloutTracking(entry)
    } else if (promptHints.length > 0 && !doesCodexRolloutMatchPromptHints(entry.nativeRolloutPath, promptHints)) {
      debugWorkState('codex-native-rollout-release', {
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        nativeRolloutPath: entry.nativeRolloutPath,
        reason: 'prompt-mismatch',
      })
      resetNativeRolloutTracking(entry)
    } else {
      return entry.nativeRolloutPath
    }
  }

  const rootDir = getCodexRolloutsDir()
  if (!fs.existsSync(rootDir)) return null
  if (
    promptHints.length === 0
    && !shouldAllowPromptlessCodexRolloutBinding(entry, [...sessions.values()])
  ) {
    return null
  }

  const match = findCodexRolloutByDirectory(rootDir, entry.cwd, entry.createdAt, {
    promptHints,
  })
  if (!match) return null

  const owner = getOtherSessionOwningNativeRollout(match.path, entry.sessionId)
  if (owner) return null

  entry.nativeRolloutPath = match.path
  entry.lastNativeRolloutSize = 0
  entry.lastNativeRolloutMtimeMs = 0
  debugWorkState('codex-native-rollout-bind', {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    nativeRolloutPath: match.path,
  })
  return match.path
}

function refreshCreatedAtFromPid(entry: SessionEntry): void {
  if (!entry.codexPid) return

  const pid = entry.codexPid
  getProcessStartTimeMs(pid).then((startedAt) => {
    const current = sessions.get(entry.sessionId)
    if (!current || current.codexPid !== pid || !startedAt) return
    if (Math.abs(current.createdAt - startedAt) < 1000) return

    current.createdAt = startedAt
    resetNativeRolloutTracking(current)
    syncEntryFromLogIfChanged(current, { notifyIdle: false, force: true })
  }).catch(() => {})
}

function emitLastResponse(entry: SessionEntry, response: string): void {
  const clean = cleanForDisplay(response)
  if (!clean || clean === entry.lastResponse) return
  entry.lastResponse = clean
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('codex-last-response', entry.sessionId, clean)
  }
}

function clearLastResponse(entry: SessionEntry): void {
  if (!entry.lastResponse) return
  entry.lastResponse = ''
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('codex-last-response', entry.sessionId, '')
  }
}

function emitWorkState(
  entry: SessionEntry,
  nextState: CodexWorkState,
  options: { force?: boolean; notifyIdle?: boolean } = {},
): void {
  const prevState = entry.lastWorkState
  if (!options.force && prevState === nextState) return
  entry.lastWorkState = nextState
  debugWorkState('codex-work-state', {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    codexPid: entry.codexPid ?? null,
    logPath: entry.logPath,
    state: nextState,
  })
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('codex-work-state', entry.sessionId, nextState)
  }
  // Feed normalized registry
  if (agentRegistry) {
    const isHookDriven = entry.lastHookEventAt != null && (Date.now() - entry.lastHookEventAt) < 10_000
    const normalizedState = nextState === 'waitingApproval' ? 'waitingApproval' as const
      : nextState === 'waitingUserInput' ? 'waitingUserInput' as const
      : nextState === 'working' ? 'working' as const
      : 'idle' as const
    if (isHookDriven) {
      agentRegistry.transition(entry.sessionId, normalizedState, 'codex-watcher-fallback')
    } else {
      agentRegistry.transitionFallback(entry.sessionId, normalizedState, 'codex-watcher-fallback')
    }
  }
  if ((options.notifyIdle ?? true) && nextState === 'idle' && prevState !== 'idle') {
    const terminalText = getLastMeaningfulText(entry.sessionId)
    // Include the raw terminal buffer tail as a last resort — Codex's TUI
    // renders via cursor positioning which can fragment lines, causing
    // getLastMeaningfulText to miss question marks on short fragments.
    const bufferTail = getTerminalBufferText(entry.sessionId).slice(-1800)
    const combined = [entry.lastResponse, terminalText, bufferTail].filter(Boolean).join('\n')
    void notifyIdleTransition(entry.sessionId, 'codex', combined || undefined, entry.lastUserPrompt || undefined)
  }
}

function resolveSnapshotWorkState(
  logSnapshot: ReturnType<typeof parseCodexRolloutLines> | null,
  nativeSnapshot: ReturnType<typeof parseCodexRolloutLines> | null,
): CodexWorkState | null {
  return logSnapshot?.workState ?? nativeSnapshot?.workState ?? null
}

function resolveDisplayWorkState(
  entry: SessionEntry,
  snapshotState: CodexWorkState | null,
  options: { preferLifecycleIfSnapshotIdle?: boolean; terminalIdleFallback?: boolean } = {},
): CodexWorkState {
  const lifecycleState = entry.lifecycleState

  if (options.terminalIdleFallback && lifecycleState === 'working') {
    return 'idle'
  }

  if (
    options.preferLifecycleIfSnapshotIdle
    && lifecycleState !== 'idle'
    && (!snapshotState || snapshotState === 'idle')
  ) {
    return lifecycleState
  }

  if (lifecycleState === 'waitingApproval' || lifecycleState === 'waitingUserInput') {
    if (snapshotState === 'waitingApproval' || snapshotState === 'waitingUserInput') {
      return snapshotState
    }
    return lifecycleState
  }

  if (lifecycleState === 'working') {
    if (snapshotState === 'waitingApproval' || snapshotState === 'waitingUserInput') {
      return snapshotState
    }
    if (snapshotState === 'idle') {
      return 'idle'
    }
    return 'working'
  }

  if (!snapshotState || snapshotState === 'idle') {
    return 'idle'
  }

  return snapshotState
}

function syncEntryFromLog(
  entry: SessionEntry,
  options: {
    notifyIdle?: boolean
    promptHints?: string[]
    nativeRolloutPath?: string | null
    preferLifecycleIfSnapshotIdle?: boolean
  } = {},
): void {
  const promptHints = options.promptHints ?? getSessionPromptHints(entry.sessionId)
  const nativeRolloutPath = options.nativeRolloutPath ?? resolveNativeRolloutPath(entry, promptHints)
  const logSnapshot = readRolloutSnapshot(entry.logPath)
  const nativeSnapshot = readRolloutSnapshot(nativeRolloutPath)

  const lastResponse = logSnapshot?.lastResponse || nativeSnapshot?.lastResponse || ''
  if (lastResponse) {
    emitLastResponse(entry, lastResponse)
  }

  const lastUserPrompt = logSnapshot?.lastUserPrompt || nativeSnapshot?.lastUserPrompt || promptHints[0] || ''
  if (lastUserPrompt) {
    entry.lastUserPrompt = lastUserPrompt
  }

  const snapshotState = resolveSnapshotWorkState(logSnapshot, nativeSnapshot)
  // Don't fire terminal idle fallback if a hook event fired recently —
  // hooks are authoritative signals from Codex that override the heuristic.
  // Use a longer grace period (10s) than the startup delay because hooks
  // may fire sporadically while Codex processes a request.
  const HOOK_GRACE_MS = 10_000
  const recentHookEvent = entry.lastHookEventAt != null
    && (Date.now() - entry.lastHookEventAt) < HOOK_GRACE_MS
  const recentTerminalOutput = hasRecentTerminalOutput(entry.sessionId, TERMINAL_IDLE_FALLBACK_DELAY_MS)
  const recentBusyIndicator = hasRecentAgentBusyIndicator(entry.sessionId, RECENT_TERMINAL_BUSY_GRACE_MS)
  const terminalIdleFallback =
    !snapshotState
    && entry.lifecycleState === 'working'
    && !recentHookEvent
    && Date.now() - entry.createdAt >= TERMINAL_IDLE_FALLBACK_DELAY_MS
    && !recentTerminalOutput
    && !recentBusyIndicator
    && isCodexIdlePromptVisible(entry.sessionId)
  if (terminalIdleFallback) {
    entry.lifecycleState = 'idle'
  }
  const nextState = resolveDisplayWorkState(entry, snapshotState, {
    preferLifecycleIfSnapshotIdle: options.preferLifecycleIfSnapshotIdle,
    terminalIdleFallback,
  })

  emitWorkState(entry, nextState, { notifyIdle: options.notifyIdle })
}

function isCodexIdlePromptVisible(sessionId: string): boolean {
  const tail = getTerminalBufferText(sessionId).slice(-1800).toLowerCase()
  if (!tail) return false

  const hasPrompt = tail.includes('ask me something.') || tail.includes('/model to change') || tail.includes('› ')
  const hasCodexUi =
    tail.includes('openai codex (v')
    || tail.includes('/model to change')
    || /\d+% left ·/.test(tail)

  return hasPrompt && hasCodexUi
}

function syncEntryFromLogIfChanged(
  entry: SessionEntry,
  options: { notifyIdle?: boolean; force?: boolean } = {},
): void {
  const promptHints = getSessionPromptHints(entry.sessionId)
  const previousNativeRolloutPath = entry.nativeRolloutPath
  const nativeRolloutPath = resolveNativeRolloutPath(entry, promptHints)
  const stat = readFileStat(entry.logPath)
  const nativeStat = readFileStat(nativeRolloutPath)
  const nextSize = stat?.size ?? 0
  const nextMtimeMs = stat?.mtimeMs ?? 0
  const nextNativeSize = nativeStat?.size ?? 0
  const nextNativeMtimeMs = nativeStat?.mtimeMs ?? 0
  const changed =
    nativeRolloutPath !== previousNativeRolloutPath
    || nextNativeSize !== entry.lastNativeRolloutSize
    || nextNativeMtimeMs !== entry.lastNativeRolloutMtimeMs
    || nextSize !== entry.lastLogSize
    || nextMtimeMs !== entry.lastLogMtimeMs

  // When the agent is expected to be active, always proceed to syncEntryFromLog
  // even if no files changed.  This lets the terminalIdleFallback detect Codex
  // returning to its idle prompt — critical when the session log stays empty
  // (e.g. warm-agent sessions that bypass the wrapper script).
  if (!options.force && !changed && entry.lifecycleState === 'idle') return

  entry.lastLogSize = nextSize
  entry.lastLogMtimeMs = nextMtimeMs
  entry.lastNativeRolloutSize = nextNativeSize
  entry.lastNativeRolloutMtimeMs = nextNativeMtimeMs
  syncEntryFromLog(entry, {
    ...options,
    promptHints,
    nativeRolloutPath,
  })
}

function stopPolling(entry: SessionEntry): void {
  if (!entry.pollInterval) return
  clearInterval(entry.pollInterval)
  entry.pollInterval = null
}

function startPolling(entry: SessionEntry): void {
  stopPolling(entry)
  entry.pollInterval = setInterval(() => {
    if (!sessions.has(entry.sessionId)) {
      stopPolling(entry)
      return
    }

    syncEntryFromLogIfChanged(entry, { notifyIdle: true })
  }, 1000)
}

function applyPendingLaunchStart(entry: SessionEntry): void {
  if (!pendingLaunchStarts.has(entry.sessionId)) return
  pendingLaunchStarts.delete(entry.sessionId)
  entry.lifecycleState = 'working'
  emitWorkState(entry, 'working', { notifyIdle: false })
}

function applyPendingHookEvent(entry: SessionEntry): void {
  const eventType = pendingHookEvents.get(entry.sessionId)
  if (!eventType) return
  pendingHookEvents.delete(entry.sessionId)

  if (eventType === 'Start') {
    entry.lifecycleState = 'working'
    syncEntryFromLog(entry, {
      preferLifecycleIfSnapshotIdle: true,
      notifyIdle: false,
    })
    return
  }

  if (eventType === 'PermissionRequest') {
    entry.lifecycleState = 'waitingApproval'
    syncEntryFromLog(entry, {
      preferLifecycleIfSnapshotIdle: true,
      notifyIdle: false,
    })
    return
  }

  if (eventType === 'UserInputRequest') {
    entry.lifecycleState = 'waitingUserInput'
    syncEntryFromLog(entry, {
      preferLifecycleIfSnapshotIdle: true,
      notifyIdle: false,
    })
    return
  }

  entry.lifecycleState = 'idle'
  syncEntryFromLog(entry)
}

export function applyCodexHookEvent(sessionId: string, eventType: CodexHookEventType): void {
  pendingHookEvents.set(sessionId, eventType)

  const entry = sessions.get(sessionId)
  if (!entry) return

  entry.lastHookEventAt = Date.now()

  debugWorkState('codex-hook-event', {
    sessionId,
    cwd: entry.cwd,
    eventType,
    logPath: entry.logPath,
    codexPid: entry.codexPid ?? null,
  })

  applyPendingHookEvent(entry)
}

export function markCodexSessionStarted(sessionId: string): void {
  pendingLaunchStarts.add(sessionId)
  pendingHookEvents.delete(sessionId)

  const entry = sessions.get(sessionId)
  if (!entry) return

  debugWorkState('codex-session-started', {
    sessionId,
    cwd: entry.cwd,
    codexPid: entry.codexPid ?? null,
    logPath: entry.logPath,
    nativeRolloutPath: entry.nativeRolloutPath,
  })

  entry.createdAt = Date.now()
  entry.lastUserPrompt = ''
  resetLogTracking(entry)
  resetNativeRolloutTracking(entry)
  clearLastResponse(entry)
  if (agentRegistry) {
    agentRegistry.reset(sessionId)
    agentRegistry.transitionFallback(sessionId, 'working', 'codex-watcher-fallback')
  }
  applyPendingLaunchStart(entry)
}

export function initCodexWatcher(window: BrowserWindow): void {
  mainWindow = window
  const { sessionLogDir } = getCodexHookRuntimePaths()
  fs.mkdirSync(sessionLogDir, { recursive: true })
}

export function watchCodexSession(sessionId: string, cwd: string, codexPid?: number): void {
  const processSessionId = resolveAgentProcessSessionId(sessionId)
  const existing = sessions.get(sessionId)
  if (existing) {
    debugWorkState('codex-watch-session', {
      sessionId,
      cwd,
      codexPid: codexPid ?? existing.codexPid ?? null,
      existing: true,
      logPath: existing.logPath,
      nativeRolloutPath: existing.nativeRolloutPath,
    })
    const hadPendingEvent = pendingHookEvents.has(sessionId)
    const hadPendingLaunchStart = pendingLaunchStarts.has(sessionId)
    const decision = getCodexWatchRegistrationDecision(existing, { cwd, codexPid })
    existing.cwd = cwd
    existing.processSessionId = processSessionId
    existing.logPath = getCodexSessionLogPath(processSessionId)
    if (codexPid != null) {
      existing.codexPid = codexPid
    }
    if (decision.shouldResetBinding) {
      existing.createdAt = Date.now()
      existing.lifecycleState = pendingLaunchStarts.has(sessionId) ? 'working' : 'idle'
      existing.lastUserPrompt = ''
      resetLogTracking(existing)
      resetNativeRolloutTracking(existing)
      clearLastResponse(existing)
      emitWorkState(existing, 'idle', { force: true, notifyIdle: false })
    }
    applyPendingLaunchStart(existing)
    applyPendingHookEvent(existing)
    if (!hadPendingEvent && !hadPendingLaunchStart) {
      syncEntryFromLogIfChanged(existing, { notifyIdle: false, force: true })
    }
    refreshCreatedAtFromPid(existing)
    startPolling(existing)
    return
  }

  const entry: SessionEntry = {
    sessionId,
    processSessionId,
    cwd,
    createdAt: Date.now(),
    lifecycleState: pendingLaunchStarts.has(sessionId) ? 'working' : 'idle',
    logPath: getCodexSessionLogPath(processSessionId),
    nativeRolloutPath: null,
    lastResponse: '',
    lastUserPrompt: '',
    lastWorkState: 'idle',
    codexPid,
    lastLogSize: 0,
    lastLogMtimeMs: 0,
    lastNativeRolloutSize: 0,
    lastNativeRolloutMtimeMs: 0,
    pollInterval: null,
    lastHookEventAt: null,
  }
  sessions.set(sessionId, entry)
  if (agentRegistry) {
    agentRegistry.register(sessionId, 'codex')
  }
  debugWorkState('codex-watch-session', {
    sessionId,
    cwd,
    codexPid: codexPid ?? null,
    existing: false,
    logPath: entry.logPath,
    nativeRolloutPath: null,
  })

  const hadPendingEvent = pendingHookEvents.has(sessionId)
  const hadPendingLaunchStart = pendingLaunchStarts.has(sessionId)
  applyPendingLaunchStart(entry)
  applyPendingHookEvent(entry)
  if (!hadPendingEvent && !hadPendingLaunchStart) {
    syncEntryFromLogIfChanged(entry, { notifyIdle: false, force: true })
  }
  refreshCreatedAtFromPid(entry)
  startPolling(entry)
}

export function unwatchCodexSession(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (entry) {
    debugWorkState('codex-unwatch-session', {
      sessionId,
      cwd: entry.cwd,
      codexPid: entry.codexPid ?? null,
      logPath: entry.logPath,
      nativeRolloutPath: entry.nativeRolloutPath,
      lastWorkState: entry.lastWorkState,
    })
    stopPolling(entry)
  }
  if (agentRegistry) {
    agentRegistry.unregister(sessionId)
  }
  sessions.delete(sessionId)
  pendingHookEvents.delete(sessionId)
  pendingLaunchStarts.delete(sessionId)
}

export function getCodexWatcherDebugState(): CodexWatcherDebugState[] {
  return [...sessions.values()].map((entry) => ({
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    codexPid: entry.codexPid ?? null,
    createdAt: entry.createdAt,
    lifecycleState: entry.lifecycleState,
    logPath: entry.logPath,
    logExists: fs.existsSync(entry.logPath),
    nativeRolloutPath: entry.nativeRolloutPath,
    nativeRolloutExists: entry.nativeRolloutPath ? fs.existsSync(entry.nativeRolloutPath) : false,
    lastWorkState: entry.lastWorkState,
    pendingHookEvent: pendingHookEvents.get(entry.sessionId) ?? null,
    lastResponsePreview: entry.lastResponse?.slice(0, 120) || '',
  }))
}

export function stopAllCodexWatchers(): void {
  for (const entry of sessions.values()) {
    stopPolling(entry)
  }
  sessions.clear()
  pendingHookEvents.clear()
  pendingLaunchStarts.clear()
  mainWindow = null
}
