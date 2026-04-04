// Granular terminal activity detection.
// Uses OSC title animation as primary working/idle signal,
// with buffer pattern classification for sub-states.

import type { ActivityState } from '../shared/types'
import { classifyActivity } from './activity-classifier'

const POLL_INTERVAL_MS = 500
const DEFAULT_IDLE_TIMEOUT_MS = 3_000
const DEFAULT_STALLED_TIMEOUT_MS = 10_000
const SNAPSHOT_SIZE = 1_000

interface SessionActivityState {
  lastSnapshot: string
  lastContentChangeAt: number
  currentState: ActivityState
  initialized: boolean
  hasOscTitle: boolean // true once any OSC title is seen for this session
}

interface DetectorConfig {
  getSnapshot: (sessionId: string) => string
  isTitleAnimating: (sessionId: string) => boolean
  onStateChange: (sessionId: string, state: ActivityState) => void
  idleTimeoutMs?: number
  stalledTimeoutMs?: number
}

const sessions = new Map<string, SessionActivityState>()
let config: DetectorConfig | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

function emitState(entry: SessionActivityState, sessionId: string, state: ActivityState): void {
  if (entry.currentState === state) return
  entry.currentState = state
  config!.onStateChange(sessionId, state)
}

function tickSession(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry || !config) return

  const raw = config.getSnapshot(sessionId)
  const snapshot = raw.length > SNAPSHOT_SIZE ? raw.slice(-SNAPSHOT_SIZE) : raw
  const titleAnimating = config.isTitleAnimating(sessionId)
  const now = Date.now()

  if (!entry.initialized) {
    entry.lastSnapshot = snapshot
    entry.lastContentChangeAt = now
    entry.initialized = true
    return
  }

  const contentChanged = snapshot !== entry.lastSnapshot
  if (contentChanged) {
    entry.lastSnapshot = snapshot
    entry.lastContentChangeAt = now
  }

  // Once we see the title animating, we know this session supports OSC titles
  // and we should rely on title animation, not content changes (which can be
  // noisy — e.g. animated ASCII art like Snitch the goose).
  if (titleAnimating) {
    entry.hasOscTitle = true
  }

  const idleTimeout = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const stalledTimeout = config.stalledTimeoutMs ?? DEFAULT_STALLED_TIMEOUT_MS
  const timeSinceChange = now - entry.lastContentChangeAt

  if (entry.hasOscTitle) {
    // --- OSC title mode (agent sessions) ---
    // Title is the authority. Content changes are ignored for working/idle.

    if (!titleAnimating && timeSinceChange > idleTimeout) {
      const subState = classifyActivity(snapshot)
      if (subState === 'turn_complete' || subState === 'interrupted') {
        emitState(entry, sessionId, subState)
      } else {
        emitState(entry, sessionId, 'idle')
      }
      return
    }

    if (titleAnimating && !contentChanged && timeSinceChange > stalledTimeout) {
      emitState(entry, sessionId, 'stalled')
      return
    }

    if (titleAnimating) {
      const subState = classifyActivity(snapshot)
      emitState(entry, sessionId, subState ?? 'working')
      return
    }
  } else {
    // --- Content-change mode (plain terminal sessions) ---
    // No OSC title support — fall back to content-change detection.

    if (!contentChanged && timeSinceChange > idleTimeout) {
      emitState(entry, sessionId, 'idle')
      return
    }

    if (contentChanged) {
      emitState(entry, sessionId, 'working')
      return
    }
  }
}

export function _tickAll(): void {
  for (const sessionId of sessions.keys()) {
    tickSession(sessionId)
  }
}

export function _getState(sessionId: string): ActivityState | undefined {
  return sessions.get(sessionId)?.currentState
}

export function startTracking(sessionId: string): void {
  if (sessions.has(sessionId)) return
  sessions.set(sessionId, {
    lastSnapshot: '',
    lastContentChangeAt: Date.now(),
    currentState: 'idle',
    initialized: false,
    hasOscTitle: false,
  })
}

export function stopTracking(sessionId: string): void {
  sessions.delete(sessionId)
}

export function initActivityDetector(cfg: DetectorConfig): void {
  stopActivityDetector()
  config = cfg
  pollTimer = setInterval(_tickAll, POLL_INTERVAL_MS)
}

export function stopActivityDetector(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  sessions.clear()
  config = null
}
