// src/main/claude-session-watcher.ts
// Detection priority:
// 1. Claude hook events (Start/Stop/PermissionRequest)
// 2. Claude transcript JSONL (transcript_path / ~/.claude/projects)
// Terminal paint is intentionally excluded from state detection.

import { BrowserWindow } from 'electron'
import { mapClaudeHookToState } from './agent-session-authority'
import {
  normalizeClaudeTranscriptPath,
  readClaudeStructuredActivity,
  resolveClaudeJsonlPath,
} from './claude-structured-activity'
import type { ClaudeHookEventType, ClaudeStateHookEventType } from './claude-hook-runtime'
import type { AgentSessionRegistry } from './agent-session-authority'
import type { ClaudeWorkState } from '../shared/types'
import { notifyIdleTransition } from './idle-notifier'
import { startTracking, stopTracking } from './terminal-activity-detector'
import { getLastMeaningfulText } from './terminal-output-buffer'
import { debugWorkState } from './work-state-debug'

export type { ClaudeWorkState }

let agentRegistry: AgentSessionRegistry | null = null

interface ClaudeHookMetadata {
  prompt?: string
  transcriptPath?: string
  cwd?: string
  lastAssistantMessage?: string
}

interface PendingClaudeHookEvent {
  eventType: ClaudeHookEventType
  metadata: ClaudeHookMetadata
}

export function setAgentSessionRegistryRef(r: AgentSessionRegistry | null): void {
  agentRegistry = r
}

interface SessionEntry {
  sessionId: string
  cwd: string
  createdAt: number
  jsonlPath: string | null
  lastWorkState: ClaudeWorkState
  lastResponse: string
  lastUserPrompt: string
  lastHookEvent: ClaudeHookEventType | null
  lastHookEventAt: number | null
  pollInterval: ReturnType<typeof setInterval> | null
}

const sessions = new Map<string, SessionEntry>()
const jsonlAssignments = new Map<string, string | null>()
const pendingHookEvents = new Map<string, PendingClaudeHookEvent>()
const pendingIdleNotify = new Map<string, ReturnType<typeof setTimeout>>()

let mainWindow: BrowserWindow | null = null

const POLL_INTERVAL_MS = 500
const HOOK_METADATA_FRESH_MS = 5_000

function isStateHookEventType(eventType: ClaudeHookEventType): eventType is ClaudeStateHookEventType {
  return eventType === 'Start' || eventType === 'Stop' || eventType === 'PermissionRequest'
}

function unassignJsonlPath(entry: SessionEntry): void {
  if (!entry.jsonlPath) return
  jsonlAssignments.delete(entry.jsonlPath)
  entry.jsonlPath = null
}

function assignJsonlPath(entry: SessionEntry, nextPath: string | null): void {
  const normalizedPath = nextPath ? normalizeClaudeTranscriptPath(nextPath) : null
  if (entry.jsonlPath === normalizedPath) return
  unassignJsonlPath(entry)
  if (!normalizedPath) return
  entry.jsonlPath = normalizedPath
  jsonlAssignments.set(normalizedPath, entry.sessionId)
}

function ensureJsonlPath(entry: SessionEntry): string | null {
  if (entry.jsonlPath) return entry.jsonlPath

  const promptHints = entry.lastUserPrompt ? [entry.lastUserPrompt] : []
  if (promptHints.length === 0) return null

  const nextPath = resolveClaudeJsonlPath({
    cwd: entry.cwd,
    sessionCreatedAt: entry.createdAt,
    sessionId: entry.sessionId,
    promptHints,
    assignments: jsonlAssignments,
  })
  assignJsonlPath(entry, nextPath)
  return entry.jsonlPath
}

function setLastResponse(entry: SessionEntry, text: string): void {
  const next = text.trim().slice(0, 200)
  if (!next || entry.lastResponse === next) return

  entry.lastResponse = next
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claude-last-response', entry.sessionId, next)
  }
  agentRegistry?.updateResponsePreview(entry.sessionId, next)
}

function checkStructuredActivity(entry: SessionEntry): boolean {
  const filePath = ensureJsonlPath(entry)
  if (!filePath) return false

  const snapshot = readClaudeStructuredActivity(filePath)
  if (!snapshot) return false

  if (snapshot.lastUserPrompt && !entry.lastUserPrompt) {
    entry.lastUserPrompt = snapshot.lastUserPrompt
  }
  if (snapshot.lastResponse) {
    setLastResponse(entry, snapshot.lastResponse)
  }

  agentRegistry?.transition(entry.sessionId, snapshot.sessionState, 'claude-jsonl')

  const nextState: ClaudeWorkState = snapshot.workState
  if (nextState === entry.lastWorkState) return true

  debugWorkState('claude-structured-activity', {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    state: snapshot.sessionState,
    jsonlPath: filePath,
  })

  emitWorkState(entry, nextState)
  return true
}

// --- State emission ---

function emitWorkState(entry: SessionEntry, nextState: ClaudeWorkState): void {
  const prevState = entry.lastWorkState
  if (prevState === nextState) return

  entry.lastWorkState = nextState

  debugWorkState('claude-work-state', {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    state: nextState,
  })

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claude-work-state', entry.sessionId, nextState)
  }

  if (nextState === 'idle' && prevState !== 'idle') {
    scheduleIdleNotification(entry.sessionId)
  } else if (nextState !== 'idle') {
    const pending = pendingIdleNotify.get(entry.sessionId)
    if (pending) {
      clearTimeout(pending)
      pendingIdleNotify.delete(entry.sessionId)
    }
  }
}

/** Delay before sending idle notification so transcript updates can settle. */
const IDLE_NOTIFY_DELAY_MS = 3_000

function scheduleIdleNotification(sessionId: string): void {
  const prev = pendingIdleNotify.get(sessionId)
  if (prev) clearTimeout(prev)

  const timer = setTimeout(() => {
    pendingIdleNotify.delete(sessionId)
    const entry = sessions.get(sessionId)
    if (!entry || entry.lastWorkState !== 'idle') return

    const structuredSnapshot = entry.jsonlPath ? readClaudeStructuredActivity(entry.jsonlPath) : null
    if (structuredSnapshot?.workState === 'working') {
      emitWorkState(entry, 'working')
      return
    }

    const responseForNotification = entry.lastResponse || getLastMeaningfulText(sessionId)
    void notifyIdleTransition(sessionId, 'claude', responseForNotification || undefined, entry.lastUserPrompt || undefined)
  }, IDLE_NOTIFY_DELAY_MS)

  pendingIdleNotify.set(sessionId, timer)
}

function clearLastResponse(entry: SessionEntry): void {
  if (!entry.lastResponse) return
  entry.lastResponse = ''
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claude-last-response', entry.sessionId, '')
  }
}

// --- Polling ---

function startPolling(entry: SessionEntry): void {
  stopPolling(entry)
  entry.pollInterval = setInterval(() => {
    if (!sessions.has(entry.sessionId)) {
      stopPolling(entry)
      return
    }
    checkStructuredActivity(entry)
  }, POLL_INTERVAL_MS)
}

function stopPolling(entry: SessionEntry): void {
  if (!entry.pollInterval) return
  clearInterval(entry.pollInterval)
  entry.pollInterval = null
}

// --- Hook event handling ---

function applyPendingHookEvent(entry: SessionEntry): void {
  const pending = pendingHookEvents.get(entry.sessionId)
  if (!pending) return
  pendingHookEvents.delete(entry.sessionId)
  applyClaudeHookEventToEntry(entry, pending.eventType, pending.metadata)
}

function applyClaudeHookMetadata(entry: SessionEntry, metadata: ClaudeHookMetadata): void {
  if (metadata.cwd) {
    entry.cwd = metadata.cwd
  }

  if (metadata.transcriptPath) {
    assignJsonlPath(entry, metadata.transcriptPath)
  }

  if (metadata.prompt) {
    entry.lastUserPrompt = metadata.prompt
    if (!metadata.transcriptPath) {
      assignJsonlPath(entry, null)
    }
  }

  if (metadata.lastAssistantMessage) {
    setLastResponse(entry, metadata.lastAssistantMessage)
  }
}

function applyClaudeHookEventToEntry(
  entry: SessionEntry,
  eventType: ClaudeHookEventType,
  metadata: ClaudeHookMetadata,
): void {
  entry.lastHookEvent = eventType
  entry.lastHookEventAt = Date.now()

  applyClaudeHookMetadata(entry, metadata)
  const structuredApplied = checkStructuredActivity(entry)

  debugWorkState('claude-hook-event', {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    eventType,
    transcriptPath: entry.jsonlPath,
  })

  if (!isStateHookEventType(eventType)) return

  if (eventType === 'Start') {
    agentRegistry?.transition(entry.sessionId, mapClaudeHookToState(eventType), 'claude-hooks')
    if (!structuredApplied || entry.lastWorkState !== 'working') {
      emitWorkState(entry, 'working')
    }
    const pending = pendingIdleNotify.get(entry.sessionId)
    if (pending) {
      clearTimeout(pending)
      pendingIdleNotify.delete(entry.sessionId)
    }
    return
  }

  if (eventType === 'PermissionRequest') {
    agentRegistry?.transition(entry.sessionId, mapClaudeHookToState(eventType), 'claude-hooks')
    if (!structuredApplied || entry.lastWorkState !== 'idle') {
      emitWorkState(entry, 'idle')
    }
    return
  }

  if (!structuredApplied || entry.lastWorkState !== 'idle') {
    agentRegistry?.transition(entry.sessionId, mapClaudeHookToState(eventType), 'claude-hooks')
    emitWorkState(entry, 'idle')
  }
}

// --- Public API ---

export function applyClaudeHookEvent(
  sessionId: string,
  eventType: ClaudeHookEventType,
  promptOrMetadata?: string | ClaudeHookMetadata,
): void {
  const metadata = typeof promptOrMetadata === 'string'
    ? { prompt: promptOrMetadata }
    : (promptOrMetadata ?? {})

  const entry = sessions.get(sessionId)
  if (!entry) {
    pendingHookEvents.set(sessionId, { eventType, metadata })
    return
  }
  applyClaudeHookEventToEntry(entry, eventType, metadata)
}

const INTERRUPT_GRACE_MS = 1_500

export function hintInterrupt(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry) return
  debugWorkState('claude-interrupt-hint', { sessionId, cwd: entry.cwd })

  setTimeout(() => {
    const next = sessions.get(sessionId)
    if (!next) return
    checkStructuredActivity(next)
  }, INTERRUPT_GRACE_MS)
}

export function markClaudeSessionStarted(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry) return

  debugWorkState('claude-session-started', {
    sessionId,
    cwd: entry.cwd,
  })

  const pendingIdle = pendingIdleNotify.get(sessionId)
  if (pendingIdle) {
    clearTimeout(pendingIdle)
    pendingIdleNotify.delete(sessionId)
  }

  const hasFreshHookMetadata =
    entry.lastHookEventAt != null
    && (Date.now() - entry.lastHookEventAt) < HOOK_METADATA_FRESH_MS

  if (!hasFreshHookMetadata) {
    entry.lastHookEvent = null
    entry.lastHookEventAt = null
    entry.lastUserPrompt = ''
    assignJsonlPath(entry, null)
  }
  clearLastResponse(entry)

  if (agentRegistry) {
    agentRegistry.reset(sessionId)
  }

  checkStructuredActivity(entry)
}

/**
 * No-op. Claude state is derived from hook events and transcript JSONL.
 */
export function observeTerminalData(_sessionId: string, _data: string): void {
  // Intentionally empty
}

export function watchSession(sessionId: string, cwd: string, _claudePid?: number): void {
  const existing = sessions.get(sessionId)
  if (existing) {
    existing.cwd = cwd
    return
  }

  const entry: SessionEntry = {
    sessionId,
    cwd,
    createdAt: Date.now(),
    jsonlPath: null,
    lastWorkState: 'idle',
    lastResponse: '',
    lastUserPrompt: '',
    lastHookEvent: null,
    lastHookEventAt: null,
    pollInterval: null,
  }
  sessions.set(sessionId, entry)
  startTracking(sessionId)

  if (agentRegistry) {
    agentRegistry.register(sessionId, 'claude')
  }

  debugWorkState('claude-watch-session', {
    sessionId,
    cwd,
  })

  applyPendingHookEvent(entry)
  startPolling(entry)
}

export function unwatchSession(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry) return

  debugWorkState('claude-unwatch-session', {
    sessionId,
    cwd: entry.cwd,
    lastWorkState: entry.lastWorkState,
  })

  stopPolling(entry)

  const pending = pendingIdleNotify.get(sessionId)
  if (pending) {
    clearTimeout(pending)
    pendingIdleNotify.delete(sessionId)
  }

  if (agentRegistry) {
    agentRegistry.unregister(sessionId)
  }

  unassignJsonlPath(entry)
  stopTracking(sessionId)
  sessions.delete(sessionId)
  pendingHookEvents.delete(sessionId)
}

export interface ClaudeWatcherDebugInfo {
  sessionId: string
  cwd: string
  lastWorkState: ClaudeWorkState
  lastHookEvent: ClaudeHookEventType | null
  lastHookEventAt: number | null
}

export function getClaudeWatcherDebugState(): ClaudeWatcherDebugInfo[] {
  return [...sessions.values()].map((entry) => ({
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    lastWorkState: entry.lastWorkState,
    lastHookEvent: entry.lastHookEvent,
    lastHookEventAt: entry.lastHookEventAt,
  }))
}

export function initClaudeWatcher(window: BrowserWindow): void {
  mainWindow = window
}

export function stopAllWatchers(): void {
  for (const entry of sessions.values()) {
    stopPolling(entry)
  }
  for (const timer of pendingIdleNotify.values()) {
    clearTimeout(timer)
  }
  pendingIdleNotify.clear()
  jsonlAssignments.clear()
  sessions.clear()
  pendingHookEvents.clear()
  mainWindow = null
}
