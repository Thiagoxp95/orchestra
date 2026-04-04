// src/main/claude-session-watcher.ts
// Simplified: only manages session lifecycle and delegates to terminal-activity-detector.

import type { BrowserWindow } from 'electron'
import { startTracking, stopTracking } from './terminal-activity-detector'

interface SessionEntry {
  sessionId: string
  cwd: string
}

const sessions = new Map<string, SessionEntry>()

export function initClaudeWatcher(_window: BrowserWindow): void {
  // Window ref no longer needed — state is emitted by terminal-activity-detector.
}

export function watchSession(sessionId: string, cwd: string, _claudePid?: number): void {
  const existing = sessions.get(sessionId)
  if (existing) {
    existing.cwd = cwd
    return
  }

  sessions.set(sessionId, { sessionId, cwd })
  startTracking(sessionId)
}

export function unwatchSession(sessionId: string): void {
  if (!sessions.has(sessionId)) return
  stopTracking(sessionId)
  sessions.delete(sessionId)
}

/**
 * No-op. Claude state is derived from terminal-activity-detector.
 */
export function observeTerminalData(_sessionId: string, _data: string): void {
  // Intentionally empty
}

export function stopAllWatchers(): void {
  for (const sessionId of sessions.keys()) {
    stopTracking(sessionId)
  }
  sessions.clear()
}
