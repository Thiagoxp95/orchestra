export type AgentSessionAuthority =
  | 'codex-app-server'
  | 'codex-watcher-fallback'

export type AgentSessionState =
  | 'unknown'
  | 'working'
  | 'waitingApproval'
  | 'waitingUserInput'
  | 'idle'
  | 'error'

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
}

const VALID_STATES: ReadonlySet<string> = new Set([
  'unknown', 'working', 'waitingApproval', 'waitingUserInput', 'idle', 'error',
])

const VALID_AUTHORITIES: ReadonlySet<string> = new Set([
  'codex-app-server', 'codex-watcher-fallback',
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
    authority: 'codex-app-server',
    connected: true,
    lastResponsePreview: '',
    lastTransitionAt: now,
    updatedAt: now,
  }
}
