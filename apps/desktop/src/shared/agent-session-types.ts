export type AgentSessionAuthority =
  | 'codex-hook'
  // Authoritative state derived from the canonical rollout JSONL files codex
  // writes to ~/.codex/sessions. Used by CodexRolloutWatcher and supersedes
  // the hook stream for working/idle transitions.
  | 'codex-rollout'
  // Legacy values, retained for type compatibility with older normalized
  // statuses that might still be in flight while we cut over.
  | 'codex-app-server'
  | 'codex-watcher-fallback'
  // Claude lifecycle reported over managed hooks (~/.claude/settings.json →
  // claude-notify.sh → the localhost listener). Supersedes the OSC-title
  // spinner-glyph heuristic (claude-work-indicator) when present; the title
  // scraper stays as the fallback for sessions whose hooks haven't installed
  // yet or failed to fire.
  | 'claude-hook'
  // Claude state read off the OSC terminal title (claude-work-indicator): the
  // braille spinner while the TUI is generating, `✳` once it is back at the
  // prompt. It is the only live signal for an *interrupted* turn — pressing Esc
  // fires no Stop hook — so it reconciles a hook stream that would otherwise
  // stay latched on 'working' forever.
  | 'claude-osc'
  // Cursor CLI lifecycle reported over managed hooks (~/.cursor/hooks.json →
  // cursor-notify.sh → the localhost listener). Cursor's TUI sets no spinner
  // title, so this is the only live signal a cursor pane has.
  | 'cursor-hook'

export type AgentSessionState =
  | 'unknown'
  | 'working'
  | 'waitingApproval'
  | 'waitingUserInput'
  | 'idle'
  | 'error'

export interface NormalizedAgentSessionStatus {
  sessionId: string
  agent: 'claude' | 'codex' | 'cursor'
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
  'codex-hook', 'codex-rollout', 'codex-app-server', 'codex-watcher-fallback',
  'claude-hook', 'claude-osc', 'cursor-hook',
])

export function isAgentSessionState(value: unknown): value is AgentSessionState {
  return typeof value === 'string' && VALID_STATES.has(value)
}

export function isAgentSessionAuthority(value: unknown): value is AgentSessionAuthority {
  return typeof value === 'string' && VALID_AUTHORITIES.has(value)
}

export function createDefaultNormalizedStatus(
  sessionId: string,
  agent: 'claude' | 'codex' | 'cursor',
): NormalizedAgentSessionStatus {
  const now = Date.now()
  return {
    sessionId,
    agent,
    state: 'unknown',
    authority: 'codex-hook',
    connected: true,
    lastResponsePreview: '',
    lastTransitionAt: now,
    updatedAt: now,
  }
}
