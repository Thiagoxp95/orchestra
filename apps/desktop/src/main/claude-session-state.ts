// Event-sourced state machine: Claude Code hook events →
// NormalizedAgentSessionStatus updates. Authority: 'claude-hooks'.
//
// Exported as a factory so tests can spin up fresh instances without
// module-global state leaking across cases.

import type { AgentSessionState, NormalizedAgentSessionStatus } from '../shared/agent-session-types'
import type { ClaudeHookEventType } from './claude-hook-runtime'

export interface ClaudeHookEvent {
  orchestraSessionId: string
  claudeSessionId: string
  eventType: ClaudeHookEventType
  message: string
}

interface PerSessionState {
  current: AgentSessionState
  lastClaudeSessionId: string | null
}

export interface ClaudeSessionStateOptions {
  onStatusUpdate: (status: NormalizedAgentSessionStatus) => void
}

export interface ClaudeSessionState {
  applyHookEvent(event: ClaudeHookEvent): void
  onOrchestraSessionClosed(orchestraSessionId: string): void
  getCurrentState(orchestraSessionId: string): AgentSessionState | null
  getLastClaudeSessionId(orchestraSessionId: string): string | null
}

function parseNotificationMessage(message: string): AgentSessionState | null {
  if (!message) return null
  const lower = message.toLowerCase()
  if (lower.includes('permission') || lower.includes('approval')) return 'waitingApproval'
  if (lower.includes('waiting for input') || lower.includes('waiting for your input')) return 'waitingUserInput'
  return null
}

function resolveNextState(
  _prev: AgentSessionState,
  event: ClaudeHookEvent,
): AgentSessionState | null {
  switch (event.eventType) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working'
    case 'PermissionRequest':
      return 'waitingApproval'
    case 'Notification': {
      const derived = parseNotificationMessage(event.message)
      return derived ?? null
    }
    case 'Stop':
      return 'idle'
    default:
      return null
  }
}

export function createClaudeSessionState(opts: ClaudeSessionStateOptions): ClaudeSessionState {
  const sessions = new Map<string, PerSessionState>()

  function emitStatus(orchestraSessionId: string, next: AgentSessionState): void {
    const now = Date.now()
    const status: NormalizedAgentSessionStatus = {
      sessionId: orchestraSessionId,
      agent: 'claude',
      state: next,
      authority: 'claude-hooks',
      connected: true,
      lastResponsePreview: '',
      lastTransitionAt: now,
      updatedAt: now,
    }
    opts.onStatusUpdate(status)
  }

  return {
    applyHookEvent(event: ClaudeHookEvent): void {
      let entry = sessions.get(event.orchestraSessionId)
      if (!entry) {
        entry = { current: 'unknown', lastClaudeSessionId: null }
        sessions.set(event.orchestraSessionId, entry)
      }

      entry.lastClaudeSessionId = event.claudeSessionId || entry.lastClaudeSessionId

      const next = resolveNextState(entry.current, event)
      if (next === null) return
      if (next === entry.current) return
      entry.current = next
      emitStatus(event.orchestraSessionId, next)
    },

    onOrchestraSessionClosed(orchestraSessionId: string): void {
      sessions.delete(orchestraSessionId)
    },

    getCurrentState(orchestraSessionId: string): AgentSessionState | null {
      return sessions.get(orchestraSessionId)?.current ?? null
    },

    getLastClaudeSessionId(orchestraSessionId: string): string | null {
      return sessions.get(orchestraSessionId)?.lastClaudeSessionId ?? null
    },
  }
}
