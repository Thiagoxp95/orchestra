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
  /** Consecutive poll ticks where the idle prompt was detected (for TUI re-render tolerance) */
  idlePromptStreak: number
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

  // Claude Code permission dialog: "Tab to amend" appears exclusively when
  // Claude is waiting for user approval on a file edit. During permission
  // dialogs the standard ❯ prompt isn't visible, so the prompt detection
  // below can't catch this state. Detect it early as a definitive idle signal.
  if (tail.includes('tab to amend')) return true

  // Must have Claude UI elements visible (status bar)
  const hasClaudeUi =
    tail.includes('shift+tab to cycle')
    || tail.includes('bypass permissions on')
    || tail.includes('run /init')
    || tail.includes('no recent activity')
  if (!hasClaudeUi) return false

  // Focus on the tail of the buffer where the prompt and status bar live.
  // The Ink TUI uses differential rendering — partial re-renders can append
  // content (like ● bullet points from responses) AFTER a previous render's ❯
  // prompt, creating false positional relationships. Using a small window
  // (~300 chars) that covers the bottom of the screen avoids this issue.
  const recentTail = raw.slice(-300)

  // The idle prompt ❯ must be visible in the recent tail
  if (!recentTail.includes('❯')) return false

  // Spinner characters are unique to Claude Code's active processing phases.
  // If ANY spinner char appears in the recent tail, Claude is working.
  // Note: ● is intentionally excluded — it's used both as a tool-use indicator
  // AND as a bullet point in response text, making it ambiguous.
  const spinnerChars = ['✢', '✳', '✱', '✶', '✻', '⏺']
  for (const ch of spinnerChars) {
    if (recentTail.includes(ch)) return false
  }

  // Check for streaming/thinking word indicators in recent tail
  const recentLower = recentTail.toLowerCase()
  if (recentLower.includes('coalescing')) return false

  return true
}

/**
 * Detect when Claude transitions from idle to working via terminal output.
 * This catches cases where hooks don't fire and startAgentRun is missed
 * (e.g., subsequent prompts in the same session).
 */
function isClaudeWorkingTerminal(sessionId: string): boolean {
  const raw = getTerminalBufferText(sessionId).slice(-1600)
  if (!raw) return false

  const tail = raw.toLowerCase()

  // Must have Claude UI visible
  const hasClaudeUi =
    tail.includes('shift+tab to cycle')
    || tail.includes('bypass permissions on')
    || tail.includes('run /init')
  if (!hasClaudeUi) return false

  // "Tab to amend" means permission dialog — user input needed, not working
  if (tail.includes('tab to amend')) return false

  // Check for spinner characters in the tail of the buffer. These are unique
  // to Claude Code's TUI and only appear when Claude is actively processing.
  const recentTail = raw.slice(-400)
  const spinnerChars = ['✢', '✳', '✱', '✶', '✻']
  const hasSpinner = spinnerChars.some((ch) => recentTail.includes(ch))

  if (!hasSpinner) return false

  // If the idle prompt ❯ appears AFTER the spinner, Claude has finished
  const lastSpinner = Math.max(...spinnerChars.map((ch) => recentTail.lastIndexOf(ch)))
  const lastPrompt = Math.max(recentTail.lastIndexOf('❯'), recentTail.toLowerCase().lastIndexOf('\n>'))
  if (lastPrompt > lastSpinner) return false

  return true
}

function checkTerminalWorkingFallback(entry: SessionEntry): void {
  if (entry.lastWorkState !== 'idle') return

  // If terminal has no recent output, don't check — avoids stale buffer reads
  if (!hasRecentTerminalOutput(entry.sessionId, 5_000)) return

  if (!isClaudeWorkingTerminal(entry.sessionId)) return

  debugWorkState('claude-terminal-working-fallback', {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
  })

  if (agentRegistry) {
    agentRegistry.transitionFallback(entry.sessionId, 'working', 'claude-watcher-fallback')
  }
  emitWorkState(entry, 'working')
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

  // Check if Claude's idle prompt is visible
  if (!isClaudeIdlePromptVisible(entry.sessionId)) {
    entry.idlePromptStreak = 0
    return
  }

  // The Ink TUI continuously re-renders (status bar, prompt refresh), which keeps
  // hasRecentTerminalOutput returning true even when Claude is idle. Instead of
  // using a hard output-silence gate, count consecutive polls where the idle prompt
  // is visible. After enough consecutive detections (streak), trust the result.
  // During active streaming the prompt isn't stable, so the streak resets.
  entry.idlePromptStreak++

  // If terminal output recently stopped, transition immediately (classic path)
  const outputStopped = !hasRecentTerminalOutput(entry.sessionId, 3_000)

  // Otherwise require the idle prompt to be consistently visible for ~3s
  // (POLL_INTERVAL_MS × 6 = 3000ms)
  const streakThreshold = 6
  if (!outputStopped && entry.idlePromptStreak < streakThreshold) return

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
    entry.idlePromptStreak = 0
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
    checkTerminalWorkingFallback(entry)
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

export function applyClaudeHookEvent(sessionId: string, eventType: ClaudeHookEventType, userMessage?: string): void {
  pendingHookEvents.set(sessionId, eventType)

  const entry = sessions.get(sessionId)
  if (!entry) return
  entry.lastHookEvent = eventType
  entry.lastHookEventAt = Date.now()

  // Store the user's prompt from UserPromptSubmit hooks (forwarded as userMessage)
  if (userMessage && eventType === 'Start') {
    entry.lastUserPrompt = userMessage
  }

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

/**
 * Called when the renderer detects Ctrl+C / Escape on a working session.
 * Instead of immediately forcing idle (which is wrong when Claude picks up a
 * queued message), we schedule an expedited terminal-idle check that bypasses
 * the normal IDLE_FALLBACK_DELAY_MS gate.
 */
const INTERRUPT_GRACE_MS = 1_500

export function hintInterrupt(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry || entry.lastWorkState !== 'working') return

  debugWorkState('claude-interrupt-hint', { sessionId, cwd: entry.cwd })

  setTimeout(() => {
    if (!sessions.has(sessionId)) return
    const e = sessions.get(sessionId)!
    if (e.lastWorkState !== 'working') return

    // If terminal is still producing output, Claude is still working
    if (hasRecentTerminalOutput(sessionId, 1_500)) return

    // Check if Claude's idle prompt is visible
    if (!isClaudeIdlePromptVisible(sessionId)) return

    debugWorkState('claude-interrupt-idle-confirmed', { sessionId, cwd: e.cwd })

    if (agentRegistry) {
      agentRegistry.transitionFallback(sessionId, 'idle', 'claude-watcher-fallback')
    }
    emitWorkState(e, 'idle')
  }, INTERRUPT_GRACE_MS)
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
    idlePromptStreak: 0,
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
