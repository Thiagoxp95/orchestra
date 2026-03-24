// src/main/claude-session-watcher.ts
// Detection priority:
// 1. Hook events (Start/Stop/PermissionRequest) — instant, authoritative
// 2. Terminal idle prompt detection — polls every 2s, catches when hooks don't fire
// 3. Ctrl+C/Escape in renderer — instant UI-side clearing

import { BrowserWindow } from 'electron'
import { mapClaudeHookToState } from './agent-session-authority'
import type { ClaudeHookEventType } from './claude-hook-runtime'
import type { AgentSessionRegistry } from './agent-session-authority'
import type { ClaudeWorkState } from '../shared/types'
import { notifyIdleTransition } from './idle-notifier'
import { getLastMeaningfulText, getTerminalBufferText, hasRecentTerminalOutput } from './terminal-output-buffer'
import { debugWorkState } from './work-state-debug'

export type { ClaudeWorkState }

let agentRegistry: AgentSessionRegistry | null = null

export function setAgentSessionRegistryRef(r: AgentSessionRegistry | null): void {
  agentRegistry = r
}

interface SessionEntry {
  sessionId: string
  cwd: string
  lastWorkState: ClaudeWorkState
  lastResponse: string
  lastUserPrompt: string
  lastHookEvent: ClaudeHookEventType | null
  lastHookEventAt: number | null
  startedWorkingAt: number | null
  pollInterval: ReturnType<typeof setInterval> | null
}

const sessions = new Map<string, SessionEntry>()
const pendingHookEvents = new Map<string, ClaudeHookEventType>()
const pendingLaunchStarts = new Set<string>()
const pendingIdleNotify = new Map<string, ReturnType<typeof setTimeout>>()

let mainWindow: BrowserWindow | null = null

/** Minimum time after entering "working" before terminal idle fallback kicks in */
const IDLE_FALLBACK_DELAY_MS = 5_000
const POLL_INTERVAL_MS = 500

// --- Terminal idle prompt detection ---

function isClaudeIdlePromptVisible(sessionId: string): boolean {
  const raw = getTerminalBufferText(sessionId).slice(-1600)
  if (!raw) return false

  const tail = raw.toLowerCase()

  // Must have Claude UI elements visible (status bar)
  const hasClaudeUi =
    tail.includes('shift+tab to cycle')
    || tail.includes('bypass permissions on')
    || tail.includes('run /init')
    || tail.includes('no recent activity')
  if (!hasClaudeUi) return false

  // Find the last occurrence of the idle prompt character.
  // When Claude is idle, ❯ is the input line — the last thing before the status bar.
  const lastPrompt = Math.max(raw.lastIndexOf('❯'), tail.lastIndexOf('\n>'))
  if (lastPrompt < 0) return false

  // Find the last occurrence of any working indicator.
  // These appear in place of ❯ when Claude is processing:
  //   ● = tool use (Reading, Editing, Bash...)
  //   ✱/✶/✻ = coalescing/thinking spinners
  //   ⏺ = thinking indicator
  const workChars = ['●', '✱', '✶', '✻', '⏺']
  const workWords = ['coalescing', 'thinking']

  let lastWork = -1
  for (const ch of workChars) {
    lastWork = Math.max(lastWork, raw.lastIndexOf(ch))
  }
  for (const word of workWords) {
    lastWork = Math.max(lastWork, tail.lastIndexOf(word))
  }

  // If the most recent indicator is a work signal, Claude is still working.
  // When idle, ❯ appears after all work output. When working, work indicators
  // appear after ❯ because Claude started processing after the user's input.
  if (lastWork > lastPrompt) return false

  return true
}

function checkTerminalIdleFallback(entry: SessionEntry): void {
  if (entry.lastWorkState !== 'working') return
  if (!entry.startedWorkingAt) return
  if (Date.now() - entry.startedWorkingAt < IDLE_FALLBACK_DELAY_MS) return

  // If a recent hook said "Start" within last few seconds, trust it
  if (
    entry.lastHookEvent === 'Start'
    && entry.lastHookEventAt != null
    && Date.now() - entry.lastHookEventAt < IDLE_FALLBACK_DELAY_MS
  ) return

  // If terminal is still producing output, don't assume idle yet.
  // Use 3s window — during coalescing, TUI redraws may gap beyond 1s.
  if (hasRecentTerminalOutput(entry.sessionId, 3_000)) return

  // Check if Claude's idle prompt is visible
  if (!isClaudeIdlePromptVisible(entry.sessionId)) return

  debugWorkState('claude-terminal-idle-fallback', {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
  })

  if (agentRegistry) {
    agentRegistry.transitionFallback(entry.sessionId, 'idle', 'claude-watcher-fallback')
  }
  emitWorkState(entry, 'idle')
}

// --- State emission ---

function emitWorkState(entry: SessionEntry, nextState: ClaudeWorkState): void {
  const prevState = entry.lastWorkState
  if (prevState === nextState) return

  entry.lastWorkState = nextState
  if (nextState === 'working') {
    entry.startedWorkingAt = Date.now()
  }

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

function scheduleIdleNotification(sessionId: string): void {
  const prev = pendingIdleNotify.get(sessionId)
  if (prev) clearTimeout(prev)

  const timer = setTimeout(() => {
    pendingIdleNotify.delete(sessionId)
    const entry = sessions.get(sessionId)
    if (!entry || entry.lastWorkState !== 'idle') return

    const responseForNotification = entry.lastResponse || getLastMeaningfulText(sessionId)
    void notifyIdleTransition(sessionId, 'claude', responseForNotification || undefined, entry.lastUserPrompt || undefined)
  }, 800)

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
    checkTerminalIdleFallback(entry)
  }, POLL_INTERVAL_MS)
}

function stopPolling(entry: SessionEntry): void {
  if (!entry.pollInterval) return
  clearInterval(entry.pollInterval)
  entry.pollInterval = null
}

// --- Hook event handling ---

function applyPendingHookEvent(entry: SessionEntry): void {
  const eventType = pendingHookEvents.get(entry.sessionId)
  if (!eventType) return
  pendingHookEvents.delete(entry.sessionId)

  if (eventType === 'Start') {
    emitWorkState(entry, 'working')
    return
  }

  if (eventType === 'PermissionRequest') {
    if (agentRegistry) {
      agentRegistry.transition(entry.sessionId, 'waitingApproval', 'claude-hooks')
    }
    emitWorkState(entry, 'idle')
    return
  }

  // Stop
  emitWorkState(entry, 'idle')
}

function applyPendingLaunchStart(entry: SessionEntry): void {
  if (!pendingLaunchStarts.has(entry.sessionId)) return
  pendingLaunchStarts.delete(entry.sessionId)
  emitWorkState(entry, 'working')
}

// --- Public API ---

export function applyClaudeHookEvent(sessionId: string, eventType: ClaudeHookEventType): void {
  pendingHookEvents.set(sessionId, eventType)

  const entry = sessions.get(sessionId)
  if (!entry) return
  entry.lastHookEvent = eventType
  entry.lastHookEventAt = Date.now()

  if (agentRegistry) {
    agentRegistry.transition(sessionId, mapClaudeHookToState(eventType), 'claude-hooks')
  }

  debugWorkState('claude-hook-event', {
    sessionId,
    cwd: entry.cwd,
    eventType,
  })

  applyPendingHookEvent(entry)
}

export function markClaudeSessionStarted(sessionId: string): void {
  pendingLaunchStarts.add(sessionId)
  pendingHookEvents.delete(sessionId)

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

  entry.lastHookEvent = null
  entry.lastHookEventAt = null
  entry.lastUserPrompt = ''
  clearLastResponse(entry)

  if (agentRegistry) {
    agentRegistry.reset(sessionId)
    agentRegistry.transitionFallback(sessionId, 'working', 'claude-watcher-fallback')
  }

  applyPendingLaunchStart(entry)
}

/**
 * No-op. Terminal data observation is no longer used for state detection.
 * The polling fallback reads from the terminal buffer directly.
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
    lastWorkState: 'idle',
    lastResponse: '',
    lastUserPrompt: '',
    lastHookEvent: null,
    lastHookEventAt: null,
    startedWorkingAt: null,
    pollInterval: null,
  }
  sessions.set(sessionId, entry)

  if (agentRegistry) {
    agentRegistry.register(sessionId, 'claude')
  }

  debugWorkState('claude-watch-session', {
    sessionId,
    cwd,
  })

  applyPendingLaunchStart(entry)
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

  sessions.delete(sessionId)
  pendingHookEvents.delete(sessionId)
  pendingLaunchStarts.delete(sessionId)
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
  sessions.clear()
  pendingHookEvents.clear()
  pendingLaunchStarts.clear()
  mainWindow = null
}
