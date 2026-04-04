// src/main/codex-session-watcher.ts
// Simplified: only manages session lifecycle and delegates to terminal-activity-detector.

import type { BrowserWindow } from 'electron'
import { startTracking, stopTracking } from './terminal-activity-detector'

interface SessionEntry {
  sessionId: string
  cwd: string
}

const sessions = new Map<string, SessionEntry>()

export function initCodexWatcher(_window: BrowserWindow): void {
  // Window ref no longer needed — state is emitted by terminal-activity-detector.
}

export function watchCodexSession(sessionId: string, cwd: string, _codexPid?: number): void {
  const existing = sessions.get(sessionId)
  if (existing) {
    existing.cwd = cwd
    return
  }

  sessions.set(sessionId, { sessionId, cwd })
  startTracking(sessionId)
}

export function unwatchCodexSession(sessionId: string): void {
  if (!sessions.has(sessionId)) return
  stopTracking(sessionId)
  sessions.delete(sessionId)
}

export function stopAllCodexWatchers(): void {
  for (const sessionId of sessions.keys()) {
    stopTracking(sessionId)
  }
  sessions.clear()
}
