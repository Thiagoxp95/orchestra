// src/main/codex-session-watcher.ts
// Manages Codex session lifecycle (watch/unwatch).

import type { BrowserWindow } from 'electron'
import type { CodexWatcherDebugState, CodexWorkState } from '../shared/types'

interface SessionEntry {
  sessionId: string
  cwd: string
  lastWorkState: CodexWorkState
}

const sessions = new Map<string, SessionEntry>()

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
  })
}

export function unwatchCodexSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function getCodexDebugState(): CodexWatcherDebugState[] {
  return [...sessions.values()].map((entry) => ({
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    lastWorkState: entry.lastWorkState,
  }))
}

export function stopAllCodexWatchers(): void {
  sessions.clear()
}
