import {
  createDefaultNormalizedStatus,
  type AgentSessionAuthority,
  type AgentSessionState,
  type NormalizedAgentSessionStatus,
} from '../shared/agent-session-types'
import { debugWorkState } from './work-state-debug'
import type { ClaudeHookEventType } from './claude-hook-runtime'
import type { CodexThreadStatus } from './codex-thread-state'

/** How long before an authoritative transition is considered stale (ms).
 *  Sessions with hook-based authority (claude-hooks, codex-app-server) get a
 *  longer timeout because hooks are known to be configured but may not fire
 *  during long-running tool calls (builds, tests, etc.).  Sessions that have
 *  never received a hook use the shorter default so fallback kicks in sooner. */
const AUTHORITY_STALE_MS = 60_000
const AUTHORITY_STALE_WITH_HOOKS_MS = 300_000

export type StateChangeListener = (
  sessionId: string,
  status: NormalizedAgentSessionStatus,
) => void

// --- Mapping helpers ---

export function mapClaudeHookToState(eventType: ClaudeHookEventType): AgentSessionState {
  switch (eventType) {
    case 'Start': return 'working'
    case 'Stop': return 'idle'
    case 'PermissionRequest': return 'waitingApproval'
  }
}

export function mapCodexThreadStatusToState(
  status: CodexThreadStatus | null | undefined,
): AgentSessionState {
  if (!status) return 'unknown'

  switch (status.type) {
    case 'idle': return 'idle'
    case 'systemError': return 'error'
    case 'notLoaded': return 'unknown'
    case 'active': {
      const flags = status.activeFlags ?? []
      if (flags.includes('waitingOnUserInput')) return 'waitingUserInput'
      if (flags.includes('waitingOnApproval')) return 'waitingApproval'
      return 'working'
    }
  }
}

// --- Registry ---

export class AgentSessionRegistry {
  private sessions = new Map<string, NormalizedAgentSessionStatus>()
  private listener: StateChangeListener

  constructor(listener: StateChangeListener) {
    this.listener = listener
  }

  register(sessionId: string, agent: 'claude' | 'codex'): NormalizedAgentSessionStatus {
    const status = createDefaultNormalizedStatus(sessionId, agent)
    this.sessions.set(sessionId, status)
    // Emit the initial default status so the renderer replaces any stale state
    // from a previous watch/unwatch cycle (e.g., session stuck as "working"
    // after Claude was closed and reopened).
    this.listener(sessionId, { ...status })
    return status
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  get(sessionId: string): NormalizedAgentSessionStatus | undefined {
    return this.sessions.get(sessionId)
  }

  getAll(): NormalizedAgentSessionStatus[] {
    return [...this.sessions.values()]
  }

  /**
   * Authoritative state transition — from hooks or app-server.
   * Always applies and emits if the state changed.
   */
  transition(
    sessionId: string,
    state: AgentSessionState,
    authority: AgentSessionAuthority,
  ): void {
    const status = this.sessions.get(sessionId)
    if (!status) return

    const changed = status.state !== state || status.authority !== authority
    const now = Date.now()

    status.state = state
    status.authority = authority
    status.connected = true
    status.degradedReason = undefined
    status.lastTransitionAt = now
    status.updatedAt = now

    if (changed) {
      this.listener(sessionId, { ...status })
    }
  }

  /**
   * Fallback state transition — from watcher heuristics.
   * Only applies when the authoritative source is absent or stale.
   */
  transitionFallback(
    sessionId: string,
    state: AgentSessionState,
    fallbackAuthority: AgentSessionAuthority,
  ): void {
    const status = this.sessions.get(sessionId)
    if (!status) return

    const isFallbackAuthority =
      status.authority === 'claude-watcher-fallback' ||
      status.authority === 'codex-watcher-fallback'
    const staleThreshold = isFallbackAuthority ? AUTHORITY_STALE_MS : AUTHORITY_STALE_WITH_HOOKS_MS
    const isStale = (Date.now() - status.lastTransitionAt) > staleThreshold

    // Only allow fallback if current authority is already fallback, or the
    // authoritative source has gone stale, or state is still unknown
    if (!isFallbackAuthority && !isStale && status.state !== 'unknown') return

    const changed = status.state !== state || status.authority !== fallbackAuthority
    const now = Date.now()

    status.state = state
    status.authority = fallbackAuthority
    status.lastTransitionAt = now
    status.updatedAt = now

    if (changed) {
      this.listener(sessionId, { ...status })
    }
  }

  /**
   * Mark a session as degraded — switches authority to fallback.
   */
  degrade(
    sessionId: string,
    fallbackAuthority: AgentSessionAuthority,
    reason: string,
  ): void {
    const status = this.sessions.get(sessionId)
    if (!status) return

    status.authority = fallbackAuthority
    status.connected = false
    status.degradedReason = reason
    status.updatedAt = Date.now()
    this.listener(sessionId, { ...status })
  }

  /**
   * Update the response preview without changing state.
   */
  updateResponsePreview(sessionId: string, preview: string): void {
    const status = this.sessions.get(sessionId)
    if (!status) return

    const trimmed = preview.slice(0, 200)
    if (status.lastResponsePreview === trimmed) return

    status.lastResponsePreview = trimmed
    status.updatedAt = Date.now()
    // Don't emit for preview-only changes — renderer polls or uses legacy channel
  }

  /**
   * Reset a session to unknown (e.g., on new agent run).
   */
  reset(sessionId: string): void {
    const status = this.sessions.get(sessionId)
    if (!status) return

    const now = Date.now()
    status.state = 'unknown'
    status.connected = true
    status.degradedReason = undefined
    status.lastResponsePreview = ''
    status.lastTransitionAt = now
    status.updatedAt = now
  }

  /**
   * Report a shadow comparison between authoritative state and watcher fallback.
   * Logs mismatches for debugging. Only call in dev mode.
   */
  reportShadowComparison(
    sessionId: string,
    watcherState: AgentSessionState,
    watcherAuthority: AgentSessionAuthority,
  ): void {
    const status = this.sessions.get(sessionId)
    if (!status) return

    const isFallbackAuthority =
      status.authority === 'claude-watcher-fallback' ||
      status.authority === 'codex-watcher-fallback'
    if (isFallbackAuthority) return

    if (status.state !== watcherState) {
      debugWorkState('agent-state-mismatch', {
        sessionId,
        authoritativeState: status.state,
        authoritativeAuthority: status.authority,
        watcherState,
        watcherAuthority,
      })
    }
  }
}
