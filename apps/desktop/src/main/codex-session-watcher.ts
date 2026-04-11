// src/main/codex-session-watcher.ts
// Manages Codex session lifecycle (watch/unwatch).

import type { BrowserWindow } from 'electron'
import type { CodexWatcherDebugState, CodexWorkState } from '../shared/types'
import type { CodexHookEventType } from './codex-hook-runtime'

interface SessionEntry {
  sessionId: string
  cwd: string
  lastWorkState: CodexWorkState
  lastHookEvent: CodexHookEventType | null
  lastHookEventAt: number | null
}

const sessions = new Map<string, SessionEntry>()

function getWorkStateForHookEvent(eventType: CodexHookEventType): CodexWorkState {
  switch (eventType) {
    case 'Start':
      return 'working'
    case 'PermissionRequest':
      return 'waitingApproval'
    case 'UserInputRequest':
      return 'waitingUserInput'
    case 'Stop':
      return 'idle'
  }
}

export function initCodexWatcher(_window: BrowserWindow): void {
  // Reserved for future use.
}

export function watchCodexSession(sessionId: string, cwd: string, _codexPid?: number): void {
  const existing = sessions.get(sessionId)
  if (existing) {
    existing.cwd = cwd
    return
  }

  sessions.set(sessionId, {
    sessionId,
    cwd,
    lastWorkState: 'idle',
    lastHookEvent: null,
    lastHookEventAt: null,
  })
}

export function unwatchCodexSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function recordCodexHookEvent(sessionId: string, eventType: CodexHookEventType): void {
  const existing = sessions.get(sessionId)
  const next: SessionEntry = existing ?? {
    sessionId,
    cwd: '',
    lastWorkState: 'idle',
    lastHookEvent: null,
    lastHookEventAt: null,
  }

  next.lastHookEvent = eventType
  next.lastHookEventAt = Date.now()
  next.lastWorkState = getWorkStateForHookEvent(eventType)

  sessions.set(sessionId, next)
}

export function getCodexDebugState(): CodexWatcherDebugState[] {
  return [...sessions.values()].map((entry) => ({
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    lastWorkState: entry.lastWorkState,
    lastHookEvent: entry.lastHookEvent,
    lastHookEventAt: entry.lastHookEventAt,
  }))
}

export function stopAllCodexWatchers(): void {
  sessions.clear()
}
