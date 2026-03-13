import * as fs from 'node:fs'
import { BrowserWindow } from 'electron'
import { cleanForDisplay } from './claude-activity-parser'
import { getCodexHookRuntimePaths, getCodexSessionLogPath, type CodexHookEventType } from './codex-hook-runtime'
import { parseCodexRolloutLines } from './codex-rollout-parser'
import { notifyIdleTransition } from './idle-notifier'
import { debugWorkState } from './work-state-debug'
import { getCodexWatchRegistrationDecision } from './codex-watch-registration'
import type { CodexWatcherDebugState } from '../shared/types'
import type { CodexWorkState } from './codex-thread-state'

export type { CodexWorkState }

interface SessionEntry {
  sessionId: string
  cwd: string
  logPath: string
  lastResponse: string
  lastWorkState: CodexWorkState
  codexPid: number | undefined
}

const sessions = new Map<string, SessionEntry>()
const pendingHookEvents = new Map<string, CodexHookEventType>()

let mainWindow: BrowserWindow | null = null

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
    void notifyIdleTransition(entry.sessionId, 'codex', entry.lastResponse || undefined)
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

  const nextState = snapshot
    ? (options.preferFallbackIfIdle && snapshot.workState === 'idle' ? fallbackState : snapshot.workState)
    : fallbackState

  emitWorkState(entry, nextState, { notifyIdle: options.notifyIdle })
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
  const existing = sessions.get(sessionId)
  if (existing) {
    const hadPendingEvent = pendingHookEvents.has(sessionId)
    const decision = getCodexWatchRegistrationDecision(existing, { cwd, codexPid })
    existing.cwd = cwd
    existing.logPath = getCodexSessionLogPath(sessionId)
    if (codexPid != null) {
      existing.codexPid = codexPid
    }
    if (decision.shouldResetBinding) {
      clearLastResponse(existing)
      emitWorkState(existing, 'idle', { force: true, notifyIdle: false })
    }
    applyPendingHookEvent(existing)
    if (!hadPendingEvent) {
      syncEntryFromLog(existing, existing.lastWorkState, { notifyIdle: false })
    }
    return
  }

  const entry: SessionEntry = {
    sessionId,
    cwd,
    logPath: getCodexSessionLogPath(sessionId),
    lastResponse: '',
    lastWorkState: 'idle',
    codexPid,
  }
  sessions.set(sessionId, entry)

  const hadPendingEvent = pendingHookEvents.has(sessionId)
  applyPendingHookEvent(entry)
  if (!hadPendingEvent) {
    syncEntryFromLog(entry, 'idle', { notifyIdle: false })
  }
}

export function unwatchCodexSession(sessionId: string): void {
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
  sessions.clear()
  pendingHookEvents.clear()
  mainWindow = null
}
