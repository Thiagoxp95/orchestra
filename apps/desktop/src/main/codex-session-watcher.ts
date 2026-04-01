// src/main/codex-session-watcher.ts
// Detection priority:
// 1. Hook events (Start/Stop/PermissionRequest/UserInputRequest) — instant, authoritative
// 2. Terminal idle prompt detection — polls every 2s, catches when hooks don't fire
// 3. Ctrl+C/Escape in renderer — instant UI-side clearing

import { BrowserWindow } from 'electron'
import type { CodexHookEventType } from './codex-hook-runtime'
import { notifyIdleTransition } from './idle-notifier'
import { getLastMeaningfulText, getTerminalBufferText, hasRecentTerminalOutput } from './terminal-output-buffer'
import { debugWorkState } from './work-state-debug'
import type { AgentSessionRegistry } from './agent-session-authority'
import type { CodexWorkState } from './codex-thread-state'

export type { CodexWorkState }

let agentRegistry: AgentSessionRegistry | null = null

export function setAgentSessionRegistryRef(r: AgentSessionRegistry | null): void {
  agentRegistry = r
}

interface SessionEntry {
  sessionId: string
  cwd: string
  lastWorkState: CodexWorkState
  lastResponse: string
  lastUserPrompt: string
  lastHookEvent: CodexHookEventType | null
  lastHookEventAt: number | null
  startedWorkingAt: number | null
  idleScreenStreak: number
  pollInterval: ReturnType<typeof setInterval> | null
}

const sessions = new Map<string, SessionEntry>()
const pendingHookEvents = new Map<string, CodexHookEventType>()
const pendingLaunchStarts = new Set<string>()
const pendingIdleNotify = new Map<string, ReturnType<typeof setTimeout>>()

let mainWindow: BrowserWindow | null = null

const IDLE_FALLBACK_DELAY_MS = 1_500
const POLL_INTERVAL_MS = 500

// --- Terminal idle prompt detection ---

function isCodexIdlePromptVisible(sessionId: string): boolean {
  const tail = getTerminalBufferText(sessionId).slice(-1800).toLowerCase()
  if (!tail) return false

  const hasPrompt = tail.includes('ask me something.') || tail.includes('/model to change') || tail.includes('› ')
  const pagerHints = [
    'q to quit',
    'enter to edit message',
    'pgup/pgdn to page',
    'home/end to jump',
    'to scroll',
    'edit prev',
  ]
  const pagerHintCount = pagerHints.reduce((count, hint) => count + (tail.includes(hint) ? 1 : 0), 0)
  const hasPager = pagerHintCount >= 3
  const hasCodexUi =
    tail.includes('openai codex (v')
    || tail.includes('/model to change')
    || tail.includes('skills')
    || /\d+% left ·/.test(tail)
    || /\d+[kmgt]? left ·/.test(tail)

  return (hasPrompt || hasPager) && hasCodexUi
}

function checkTerminalIdleFallback(entry: SessionEntry): void {
  if (entry.lastWorkState === 'idle') return
  if (!entry.startedWorkingAt) return
  if (Date.now() - entry.startedWorkingAt < IDLE_FALLBACK_DELAY_MS) return

  if (
    entry.lastHookEvent === 'Start'
    && entry.lastHookEventAt != null
    && Date.now() - entry.lastHookEventAt < IDLE_FALLBACK_DELAY_MS
  ) return

  const idlePromptVisible = isCodexIdlePromptVisible(entry.sessionId)
  if (!idlePromptVisible) {
    entry.idleScreenStreak = Math.max(0, entry.idleScreenStreak - 1)
    return
  }

  entry.idleScreenStreak += 1
  const outputStopped = !hasRecentTerminalOutput(entry.sessionId, 1_500)
  if (!outputStopped && entry.idleScreenStreak < 4) return

  debugWorkState('codex-terminal-idle-fallback', {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
  })

  if (agentRegistry) {
    agentRegistry.transitionFallback(entry.sessionId, 'idle', 'codex-watcher-fallback')
  }
  emitWorkState(entry, 'idle')
}

// --- State emission ---

function mapHookToWorkState(eventType: CodexHookEventType): CodexWorkState {
  switch (eventType) {
    case 'Start': return 'working'
    case 'Stop': return 'idle'
    case 'PermissionRequest': return 'waitingApproval'
    case 'UserInputRequest': return 'waitingUserInput'
  }
}

function mapToNormalizedState(state: CodexWorkState) {
  if (state === 'waitingApproval') return 'waitingApproval' as const
  if (state === 'waitingUserInput') return 'waitingUserInput' as const
  if (state === 'working') return 'working' as const
  return 'idle' as const
}

function emitWorkState(entry: SessionEntry, nextState: CodexWorkState): void {
  const prevState = entry.lastWorkState
  if (prevState === nextState) return

  entry.lastWorkState = nextState
  if (nextState === 'working') {
    entry.startedWorkingAt = Date.now()
    entry.idleScreenStreak = 0
  }

  debugWorkState('codex-work-state', {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    state: nextState,
  })

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('codex-work-state', entry.sessionId, nextState)
  }

  if (agentRegistry) {
    const normalizedState = mapToNormalizedState(nextState)
    const isHookDriven =
      entry.lastHookEventAt != null
      && (Date.now() - entry.lastHookEventAt) < 10_000

    if (isHookDriven) {
      agentRegistry.transition(entry.sessionId, normalizedState, 'codex-watcher-fallback')
    } else {
      agentRegistry.transitionFallback(entry.sessionId, normalizedState, 'codex-watcher-fallback')
    }
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

/** Delay before sending idle notification — long enough for the working-fallback
 *  to correct false idle transitions from terminal parsing noise. */
const IDLE_NOTIFY_DELAY_MS = 3_000

function scheduleIdleNotification(sessionId: string): void {
  const prev = pendingIdleNotify.get(sessionId)
  if (prev) clearTimeout(prev)

  const timer = setTimeout(() => {
    pendingIdleNotify.delete(sessionId)
    const entry = sessions.get(sessionId)
    if (!entry || entry.lastWorkState !== 'idle') return

    const responseForNotification = entry.lastResponse || getLastMeaningfulText(sessionId)
    void notifyIdleTransition(sessionId, 'codex', responseForNotification || undefined, entry.lastUserPrompt || undefined)
  }, IDLE_NOTIFY_DELAY_MS)

  pendingIdleNotify.set(sessionId, timer)
}

function clearLastResponse(entry: SessionEntry): void {
  if (!entry.lastResponse) return
  entry.lastResponse = ''
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('codex-last-response', entry.sessionId, '')
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

  emitWorkState(entry, mapHookToWorkState(eventType))
}

function applyPendingLaunchStart(entry: SessionEntry): void {
  if (!pendingLaunchStarts.has(entry.sessionId)) return
  pendingLaunchStarts.delete(entry.sessionId)
  emitWorkState(entry, 'working')
}

// --- Public API ---

export function applyCodexHookEvent(sessionId: string, eventType: CodexHookEventType): void {
  pendingHookEvents.set(sessionId, eventType)

  const entry = sessions.get(sessionId)
  if (!entry) return

  entry.lastHookEvent = eventType
  entry.lastHookEventAt = Date.now()

  debugWorkState('codex-hook-event', {
    sessionId,
    cwd: entry.cwd,
    eventType,
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
    agentRegistry.transitionFallback(sessionId, 'working', 'codex-watcher-fallback')
  }

  applyPendingLaunchStart(entry)
}

export function initCodexWatcher(window: BrowserWindow): void {
  mainWindow = window
}

export function watchCodexSession(sessionId: string, cwd: string, _codexPid?: number): void {
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
    idleScreenStreak: 0,
    pollInterval: null,
  }
  sessions.set(sessionId, entry)

  if (agentRegistry) {
    agentRegistry.register(sessionId, 'codex')
  }

  debugWorkState('codex-watch-session', {
    sessionId,
    cwd,
  })

  applyPendingLaunchStart(entry)
  applyPendingHookEvent(entry)
  startPolling(entry)
}

export function unwatchCodexSession(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry) return

  debugWorkState('codex-unwatch-session', {
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

export interface CodexWatcherDebugInfo {
  sessionId: string
  cwd: string
  lastWorkState: CodexWorkState
  lastHookEvent: CodexHookEventType | null
  lastHookEventAt: number | null
}

export function getCodexWatcherDebugState(): CodexWatcherDebugInfo[] {
  return [...sessions.values()].map((entry) => ({
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    lastWorkState: entry.lastWorkState,
    lastHookEvent: entry.lastHookEvent,
    lastHookEventAt: entry.lastHookEventAt,
  }))
}

export function stopAllCodexWatchers(): void {
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
