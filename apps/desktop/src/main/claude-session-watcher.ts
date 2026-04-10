// src/main/claude-session-watcher.ts
// Manages Claude session lifecycle (watch/unwatch).

import type { BrowserWindow } from 'electron'

interface SessionEntry {
  sessionId: string
  cwd: string
}

const sessions = new Map<string, SessionEntry>()

export function initClaudeWatcher(_window: BrowserWindow): void {
  // Reserved for future use.
}

export function watchSession(sessionId: string, cwd: string, _claudePid?: number): void {
  const existing = sessions.get(sessionId)
  if (existing) {
    existing.cwd = cwd
    return
  }

  sessions.set(sessionId, { sessionId, cwd })
}

export function unwatchSession(sessionId: string): void {
  sessions.delete(sessionId)
}

/**
 * No-op kept for API compatibility.
 */
export function observeTerminalData(_sessionId: string, _data: string): void {
  // Intentionally empty
}

export function stopAllWatchers(): void {
  sessions.clear()
}
