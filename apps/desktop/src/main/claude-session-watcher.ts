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
  lastInterruptHintAt: number | null
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
const IDLE_FALLBACK_DELAY_MS = 2_000
const POLL_INTERVAL_MS = 500
const WORKING_TAIL_WINDOW_CHARS = 160
const WORKING_STREAMING_TAIL_WINDOW_CHARS = 260
const PROMPT_TAIL_WINDOW_CHARS = 900
const INTERRUPT_OVERRIDE_WINDOW_MS = 15_000
const CLAUDE_SPINNER_CHARS = ['✢', '✳', '✶', '✻', '✽']

type ClaudeTerminalPromptState = 'none' | 'idle' | 'waitingApproval' | 'waitingUserInput'

// --- Terminal idle prompt detection ---

function hasClaudePromptGlyph(text: string): boolean {
  return text.includes('❯') || text.includes('\u23F5')
}

function getClaudePromptAnchorIndex(text: string): number {
  const lower = text.toLowerCase()
  return Math.max(
    text.lastIndexOf('❯'),
    text.lastIndexOf('\u23F5'),
    lower.lastIndexOf('tab to amend'),
    lower.lastIndexOf('claude wants to'),
    lower.lastIndexOf('do you want to'),
    lower.lastIndexOf('interrupted.'),
    lower.lastIndexOf('what should claude do instead'),
    lower.lastIndexOf('what should claude do differently'),
  )
}

function hasClaudeWorkingIndicators(text: string, promptAnchorIndex = -1): boolean {
  const lastSpinner = Math.max(...CLAUDE_SPINNER_CHARS.map((ch) => text.lastIndexOf(ch)))
  if (lastSpinner > promptAnchorIndex) return true

  const lower = text.toLowerCase()
  if (lower.lastIndexOf('coalescing') > promptAnchorIndex) return true

  const matches = [...text.matchAll(/[A-Z][a-z]+ing\u2026/g)]
  const lastStreaming = matches.length > 0 ? (matches.at(-1)?.index ?? -1) : -1
  return lastStreaming > promptAnchorIndex
}

function isClaudeApprovalPromptVisibleText(text: string): boolean {
  const lower = text.toLowerCase()

  // Edit approval uses a dedicated footer instead of the standard prompt.
  if (lower.includes('tab to amend')) return true

  const hasYesOption = /(?:^|\n)\s*(?:❯\s*)?1\.\s*yes\b/i.test(text)
  const hasNoOption = /(?:^|\n)\s*(?:❯\s*)?\d+\.\s*no\b/i.test(text)
  if (!hasYesOption || !hasNoOption) return false

  if (lower.includes('claude wants to')) return true
  if (lower.includes('do you want to make this edit')) return true

  return lower.includes('do you want to') && (
    lower.includes('allow claude')
    || lower.includes('fetch this content')
    || lower.includes("don't ask again")
    || lower.includes('don’t ask again')
    || lower.includes('for this session')
  )
}

function isClaudeInterruptPromptVisibleText(text: string): boolean {
  const tail = text.toLowerCase()
  return tail.includes('interrupted.')
    && (
      tail.includes('what should claude do instead')
      || tail.includes('what should claude do differently')
    )
}

function getClaudeTerminalPromptState(sessionId: string): ClaudeTerminalPromptState {
  const raw = getTerminalBufferText(sessionId).slice(-2000)
  if (!raw) return 'none'

  const recentTail = raw.slice(-PROMPT_TAIL_WINDOW_CHARS)
  const recentLower = recentTail.toLowerCase()

  const approvalPromptVisible = isClaudeApprovalPromptVisibleText(recentTail)
  const interruptPromptVisible = isClaudeInterruptPromptVisibleText(recentTail)
  const promptAnchorIndex = getClaudePromptAnchorIndex(recentTail)

  // Standard idle rendering includes Claude's bottom status bar. Approval
  // prompts like "allow Claude to fetch this content?" do not, so treat those
  // as valid prompt contexts on their own.
  const hasClaudeUi =
    recentLower.includes('shift+tab to cycle')
    || recentLower.includes('bypass permissions on')
    || recentLower.includes('run /init')
    || recentLower.includes('no recent activity')

  if (!hasClaudeUi && !approvalPromptVisible && !interruptPromptVisible) return 'none'
  if (!approvalPromptVisible && !interruptPromptVisible && !hasClaudePromptGlyph(recentTail)) return 'none'
  if (hasClaudeWorkingIndicators(recentTail, promptAnchorIndex)) return 'none'

  if (approvalPromptVisible) return 'waitingApproval'
  if (interruptPromptVisible) return 'waitingUserInput'
  return 'idle'
}

/**
 * Detect when Claude transitions from idle to working via terminal output.
 * This catches cases where hooks don't fire and startAgentRun is missed
 * (e.g., subsequent prompts in the same session).
 */
function isClaudeWorkingTerminal(sessionId: string): boolean {
  if (getClaudeTerminalPromptState(sessionId) !== 'none') return false

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
  // Claude Code v2.1+ spinner frames: · ✢ ✳ ✶ ✻ ✽ (* for Ghostty).
  // · and * excluded (too common in regular text).
  // Keep this window tight. Claude's status bar lives at the bottom of the
  // terminal, while older redraw fragments can linger deeper in the buffer and
  // otherwise retrigger "working" immediately after an idle transition.
  const recentTail = raw.slice(-WORKING_TAIL_WINDOW_CHARS)
  const hasSpinner = CLAUDE_SPINNER_CHARS.some((ch) => recentTail.includes(ch))

  // Claude can also show a verbing status line like "Scurrying…" or
  // "Coalescing…" near the bottom even when no spinner frame is captured.
  // Treat that as positive evidence of active work, but only in a tight
  // bottom-of-terminal window so older redraw fragments do not revive idle
  // sessions.
  const streamingTail = raw.slice(-WORKING_STREAMING_TAIL_WINDOW_CHARS)
  if (/[A-Z][a-z]+ing\u2026/.test(streamingTail)) return true

  if (!hasSpinner) return false

  // If the idle prompt appears AFTER the spinner, Claude has finished.
  // Check ❯ (normal mode), ⏵ U+23F5 (bypass permissions mode), and \n> (fallback).
  const lastSpinner = Math.max(...CLAUDE_SPINNER_CHARS.map((ch) => recentTail.lastIndexOf(ch)))
  const lastPrompt = Math.max(recentTail.lastIndexOf('❯'), recentTail.lastIndexOf('\u23F5'), recentTail.toLowerCase().lastIndexOf('\n>'))
  if (lastPrompt > lastSpinner) return false

  return true
}

function isClaudeInterruptPromptVisible(sessionId: string): boolean {
  const raw = getTerminalBufferText(sessionId).slice(-1200)
  return raw ? isClaudeInterruptPromptVisibleText(raw) : false
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
    // If the registry rejected the fallback (authoritative source is fresh),
    // don't override the watcher state — prevents false working transitions.
    const registryState = agentRegistry.get(entry.sessionId)
    if (registryState && registryState.state !== 'working') return
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

  const promptState = getClaudeTerminalPromptState(entry.sessionId)
  if (promptState === 'none') {
    // Decrement instead of hard-resetting so occasional TUI re-render noise
    // (which can briefly hide the idle prompt) doesn't restart the full streak.
    // During active streaming most polls will fail, quickly depleting any streak.
    entry.idlePromptStreak = Math.max(0, entry.idlePromptStreak - 2)
    return
  }

  // The Ink TUI continuously re-renders (status bar, prompt refresh), which keeps
  // hasRecentTerminalOutput returning true even when Claude is idle. Instead of
  // using a hard output-silence gate, count consecutive polls where the idle prompt
  // is visible. After enough consecutive detections (streak), trust the result.
  // During active streaming the prompt isn't stable, so the streak resets.
  entry.idlePromptStreak++

  // If terminal output recently stopped, transition immediately (classic path)
  const outputStopped = !hasRecentTerminalOutput(entry.sessionId, 2_000)

  // Otherwise require the idle prompt to be consistently visible for ~2s
  // (POLL_INTERVAL_MS × 4 = 2000ms)
  const streakThreshold = 4
  if (!outputStopped && entry.idlePromptStreak < streakThreshold) return

  debugWorkState('claude-terminal-idle-fallback', {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
  })

  if (agentRegistry) {
    if (promptState === 'waitingApproval') {
      agentRegistry.transitionFallback(entry.sessionId, 'waitingApproval', 'claude-watcher-fallback')
    } else if (promptState === 'waitingUserInput') {
      agentRegistry.transition(entry.sessionId, 'waitingUserInput', 'claude-watcher-fallback')
    } else {
      const interruptOverrideActive =
        entry.lastInterruptHintAt != null
        && (Date.now() - entry.lastInterruptHintAt) < INTERRUPT_OVERRIDE_WINDOW_MS

      if (interruptOverrideActive && isClaudeInterruptPromptVisible(entry.sessionId)) {
        agentRegistry.transition(entry.sessionId, 'waitingUserInput', 'claude-watcher-fallback')
      } else {
        agentRegistry.transitionFallback(entry.sessionId, 'idle', 'claude-watcher-fallback')
      }
    }
    // If the registry rejected the fallback (authoritative source is fresh),
    // don't override the watcher state — prevents false idle transitions and
    // false notifications during long tool calls.
    const registryState = agentRegistry.get(entry.sessionId)
    if (
      registryState
      && registryState.state !== 'idle'
      && registryState.state !== 'waitingApproval'
      && registryState.state !== 'waitingUserInput'
    ) {
      entry.idlePromptStreak = 0
      return
    }
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
    entry.lastInterruptHintAt = null
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

    // Re-verify: if the terminal now shows a spinner, the idle was a false positive
    if (isClaudeWorkingTerminal(sessionId)) {
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

  entry.lastInterruptHintAt = Date.now()
  debugWorkState('claude-interrupt-hint', { sessionId, cwd: entry.cwd })

  setTimeout(() => {
    if (!sessions.has(sessionId)) return
    const e = sessions.get(sessionId)!
    if (e.lastWorkState !== 'working') return

    // If terminal is still producing output, Claude is still working
    if (hasRecentTerminalOutput(sessionId, 1_500)) return

    // Check if Claude is visibly back at the prompt or asking what to do next
    const promptState = getClaudeTerminalPromptState(sessionId)
    if (promptState === 'none') return

    debugWorkState('claude-interrupt-idle-confirmed', { sessionId, cwd: e.cwd })

    if (agentRegistry) {
      agentRegistry.transition(
        sessionId,
        promptState === 'waitingApproval'
          ? 'waitingApproval'
          : promptState === 'waitingUserInput'
            ? 'waitingUserInput'
            : 'idle',
        'claude-watcher-fallback',
      )
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
    lastInterruptHintAt: null,
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
