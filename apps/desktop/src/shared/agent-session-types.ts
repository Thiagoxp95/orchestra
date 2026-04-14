export type AgentSessionAuthority =
  | 'codex-app-server'
  | 'claude-hooks'
  | 'claude-jsonl'
  | 'codex-watcher-fallback'
  // 'claude-watcher-fallback' removed — Claude detection is hook-only

export type AgentSessionState =
  | 'unknown'
  | 'working'
  | 'waitingApproval'
  | 'waitingUserInput'
  | 'idle'
  | 'error'

/**
 * Edge-style transition tag. Consumers (notifier, sidebar, etc.) use this
 * instead of diffing successive `state` values — that diff lost information
 * and was the root cause of spurious "finished" notifications (e.g. a
 * waitingApproval→idle status emit looked identical to a real working→idle
 * finish). The state machine knows which edge this emit represents; we
 * surface it explicitly.
 *
 *  - `turn-started`: the session just entered a turn (working)
 *  - `turn-ended`:   a turn completed cleanly — fire "finished" once
 *  - `attention`:    moved to waitingApproval / waitingUserInput within a turn
 *  - `status`:       any other emit (metadata refresh, state refresh without edge)
 */
export type AgentSessionTransition =
  | 'turn-started'
  | 'turn-ended'
  | 'attention'
  | 'status'

export interface NormalizedAgentSessionStatus {
  sessionId: string
  agent: 'claude' | 'codex'
  state: AgentSessionState
  authority: AgentSessionAuthority
  connected: boolean
  degradedReason?: string
  lastResponsePreview: string
  lastTransitionAt: number
  updatedAt: number
  /** Opaque turn identifier. Changes exactly when a new turn starts. */
  turnId?: string
  /** Which semantic edge triggered this emit. Defaults to `'status'` if absent. */
  transition?: AgentSessionTransition
  /**
   * True when this `turn-ended` emit was caused by a user-initiated interrupt
   * (Esc / Ctrl+C) rather than a natural Claude-driven Stop. Used by the
   * notifier to suppress the "Claude is ready" toast — the user is actively
   * interacting with the app and doesn't need to be pinged.
   */
  wasInterrupted?: boolean
}

const VALID_STATES: ReadonlySet<string> = new Set([
  'unknown', 'working', 'waitingApproval', 'waitingUserInput', 'idle', 'error',
])

const VALID_AUTHORITIES: ReadonlySet<string> = new Set([
  'codex-app-server', 'claude-hooks', 'claude-jsonl', 'codex-watcher-fallback',
])

export function isAgentSessionState(value: unknown): value is AgentSessionState {
  return typeof value === 'string' && VALID_STATES.has(value)
}

export function isAgentSessionAuthority(value: unknown): value is AgentSessionAuthority {
  return typeof value === 'string' && VALID_AUTHORITIES.has(value)
}

export function createDefaultNormalizedStatus(
  sessionId: string,
  agent: 'claude' | 'codex',
): NormalizedAgentSessionStatus {
  const now = Date.now()
  return {
    sessionId,
    agent,
    state: 'unknown',
    authority: agent === 'claude' ? 'claude-hooks' : 'codex-app-server',
    connected: true,
    lastResponsePreview: '',
    lastTransitionAt: now,
    updatedAt: now,
  }
}
