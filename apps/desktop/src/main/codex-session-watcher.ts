import * as fs from 'node:fs'
import { BrowserWindow } from 'electron'
import { cleanForDisplay } from './claude-activity-parser'
import { getCodexHookRuntimePaths, getCodexSessionLogPath, type CodexHookEventType } from './codex-hook-runtime'
import { parseCodexRolloutLines } from './codex-rollout-parser'
import { notifyIdleTransition } from './idle-notifier'
import { getLastMeaningfulText } from './terminal-output-buffer'
import { debugWorkState } from './work-state-debug'
import { getCodexWatchRegistrationDecision } from './codex-watch-registration'
import { resolveAgentProcessSessionId } from './agent-session-aliases'
import type { CodexWatcherDebugState } from '../shared/types'
import type { CodexWorkState } from './codex-thread-state'

export type { CodexWorkState }

interface SessionEntry {
  sessionId: string
  processSessionId: string
  cwd: string
  logPath: string
  lastResponse: string
  lastUserPrompt: string
  lastWorkState: CodexWorkState
  codexPid: number | undefined
  lastLogSize: number
  lastLogMtimeMs: number
  pollInterval: ReturnType<typeof setInterval> | null
}

const sessions = new Map<string, SessionEntry>()
const pendingHookEvents = new Map<string, CodexHookEventType>()

let mainWindow: BrowserWindow | null = null

function readLogStat(logPath: string): { size: number; mtimeMs: number } | null {
  try {
    const stat = fs.statSync(logPath)
    return { size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

function readLogSnapshot(logPath: string): ReturnType<typeof parseCodexRolloutLines> | null {
  try {
    if (!fs.existsSync(logPath)) return null
    const text = fs.readFileSync(logPath, 'utf8')
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
  if ((options.notifyIdle ?? true) && nextState === 'idle' && prevState !== 'idle') {
    const terminalText = getLastMeaningfulText(entry.sessionId)
    // Combine log response and terminal text so detectRequiresUserInput
    // can catch questions visible in the terminal even when the log-based
    // response is stale or missing the question text.
    const combined = [entry.lastResponse, terminalText].filter(Boolean).join('\n')
    void notifyIdleTransition(entry.sessionId, 'codex', combined || undefined, entry.lastUserPrompt || undefined)
  }
}

function syncEntryFromLog(
  entry: SessionEntry,
  fallbackState: CodexWorkState,
  options: { preferFallbackIfIdle?: boolean; notifyIdle?: boolean } = {},
): void {
  const snapshot = readLogSnapshot(entry.logPath)
  if (snapshot?.lastResponse) {
    emitLastResponse(entry, snapshot.lastResponse)
  }
  if (snapshot?.lastUserPrompt) {
    entry.lastUserPrompt = snapshot.lastUserPrompt
  }

  const nextState = snapshot
    ? (options.preferFallbackIfIdle && snapshot.workState === 'idle' ? fallbackState : snapshot.workState)
    : fallbackState

  emitWorkState(entry, nextState, { notifyIdle: options.notifyIdle })
}

function syncEntryFromLogIfChanged(
  entry: SessionEntry,
  fallbackState: CodexWorkState,
  options: { preferFallbackIfIdle?: boolean; notifyIdle?: boolean; force?: boolean } = {},
): void {
  const stat = readLogStat(entry.logPath)
  const nextSize = stat?.size ?? 0
  const nextMtimeMs = stat?.mtimeMs ?? 0
  const changed =
    nextSize !== entry.lastLogSize
    || nextMtimeMs !== entry.lastLogMtimeMs

  if (!options.force && !changed) return

  entry.lastLogSize = nextSize
  entry.lastLogMtimeMs = nextMtimeMs
  syncEntryFromLog(entry, fallbackState, options)
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

    syncEntryFromLogIfChanged(entry, entry.lastWorkState, { notifyIdle: true })
  }, 1000)
}

function applyPendingHookEvent(entry: SessionEntry): void {
  const eventType = pendingHookEvents.get(entry.sessionId)
  if (!eventType) return
  pendingHookEvents.delete(entry.sessionId)

  if (eventType === 'Start') {
    syncEntryFromLog(entry, 'working', { preferFallbackIfIdle: true, notifyIdle: false })
    return
  }

  if (eventType === 'PermissionRequest') {
    syncEntryFromLog(entry, 'waitingApproval', { preferFallbackIfIdle: true, notifyIdle: false })
    return
  }

  if (eventType === 'UserInputRequest') {
    syncEntryFromLog(entry, 'waitingUserInput', { preferFallbackIfIdle: true, notifyIdle: false })
    return
  }

  syncEntryFromLog(entry, 'idle')
}

export function applyCodexHookEvent(sessionId: string, eventType: CodexHookEventType): void {
  pendingHookEvents.set(sessionId, eventType)

  const entry = sessions.get(sessionId)
  if (!entry) return

  debugWorkState('codex-hook-event', {
    sessionId,
    cwd: entry.cwd,
    eventType,
    logPath: entry.logPath,
    codexPid: entry.codexPid ?? null,
  })

  applyPendingHookEvent(entry)
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
    const hadPendingEvent = pendingHookEvents.has(sessionId)
    const decision = getCodexWatchRegistrationDecision(existing, { cwd, codexPid })
    existing.cwd = cwd
    existing.processSessionId = processSessionId
    existing.logPath = getCodexSessionLogPath(processSessionId)
    if (codexPid != null) {
      existing.codexPid = codexPid
    }
    if (decision.shouldResetBinding) {
      resetLogTracking(existing)
      clearLastResponse(existing)
      emitWorkState(existing, 'idle', { force: true, notifyIdle: false })
    }
    applyPendingHookEvent(existing)
    if (!hadPendingEvent) {
      syncEntryFromLogIfChanged(existing, existing.lastWorkState, { notifyIdle: false, force: true })
    }
    startPolling(existing)
    return
  }

  const entry: SessionEntry = {
    sessionId,
    processSessionId,
    cwd,
    logPath: getCodexSessionLogPath(processSessionId),
    lastResponse: '',
    lastUserPrompt: '',
    lastWorkState: 'idle',
    codexPid,
    lastLogSize: 0,
    lastLogMtimeMs: 0,
    pollInterval: null,
  }
  sessions.set(sessionId, entry)

  const hadPendingEvent = pendingHookEvents.has(sessionId)
  applyPendingHookEvent(entry)
  if (!hadPendingEvent) {
    syncEntryFromLogIfChanged(entry, 'idle', { notifyIdle: false, force: true })
  }
  startPolling(entry)
}

export function unwatchCodexSession(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (entry) {
    stopPolling(entry)
  }
  sessions.delete(sessionId)
  pendingHookEvents.delete(sessionId)
}

export function getCodexWatcherDebugState(): CodexWatcherDebugState[] {
  return [...sessions.values()].map((entry) => ({
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    codexPid: entry.codexPid ?? null,
    logPath: entry.logPath,
    logExists: fs.existsSync(entry.logPath),
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
  mainWindow = null
}
