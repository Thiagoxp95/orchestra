// Universal terminal activity detection via content change polling.
// If terminal content keeps changing -> working. If static for IDLE_TIMEOUT_MS -> idle.

const POLL_INTERVAL_MS = 500
const DEFAULT_IDLE_TIMEOUT_MS = 3_000
const SNAPSHOT_SIZE = 1_000

interface SessionActivityState {
  lastSnapshot: string
  lastChangeTime: number
  currentState: 'working' | 'idle'
  initialized: boolean
}

interface DetectorConfig {
  getSnapshot: (sessionId: string) => string
  onStateChange: (sessionId: string, state: 'working' | 'idle') => void
  idleTimeoutMs?: number
}

const sessions = new Map<string, SessionActivityState>()
let config: DetectorConfig | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

function tickSession(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry || !config) return

  const raw = config.getSnapshot(sessionId)
  const snapshot = raw.length > SNAPSHOT_SIZE ? raw.slice(-SNAPSHOT_SIZE) : raw

  if (!entry.initialized) {
    entry.lastSnapshot = snapshot
    entry.lastChangeTime = Date.now()
    entry.initialized = true
    return
  }

  if (snapshot !== entry.lastSnapshot) {
    entry.lastSnapshot = snapshot
    entry.lastChangeTime = Date.now()
    if (entry.currentState !== 'working') {
      entry.currentState = 'working'
      config.onStateChange(sessionId, 'working')
    }
  } else {
    const idleTimeout = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    if (
      entry.currentState === 'working' &&
      Date.now() - entry.lastChangeTime > idleTimeout
    ) {
      entry.currentState = 'idle'
      config.onStateChange(sessionId, 'idle')
    }
  }
}

export function _tickAll(): void {
  for (const sessionId of sessions.keys()) {
    tickSession(sessionId)
  }
}

export function _getState(sessionId: string): 'working' | 'idle' | undefined {
  return sessions.get(sessionId)?.currentState
}

export function startTracking(sessionId: string): void {
  if (sessions.has(sessionId)) return
  sessions.set(sessionId, {
    lastSnapshot: '',
    lastChangeTime: Date.now(),
    currentState: 'idle',
    initialized: false,
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
