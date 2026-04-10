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
  transcriptPath?: string
}

interface PerSessionState {
  current: AgentSessionState
  lastClaudeSessionId: string | null
  lastTranscriptPath: string | null
}

export interface ClaudeSessionStateOptions {
  onStatusUpdate: (status: NormalizedAgentSessionStatus) => void
}

export interface ClaudeSessionState {
  applyHookEvent(event: ClaudeHookEvent): void
  onOrchestraSessionClosed(orchestraSessionId: string): void
  getCurrentState(orchestraSessionId: string): AgentSessionState | null
  getLastClaudeSessionId(orchestraSessionId: string): string | null
  getLastTranscriptPath(orchestraSessionId: string): string | null
  /**
   * Override the state to `waitingUserInput`, but only if the session is
   * currently `idle`. Used when an async classifier (Gemini) determines that
   * the last assistant message requires user input after a Stop hook.
   */
  markNeedsUserInputIfIdle(orchestraSessionId: string): void
}

function parseNotificationMessage(message: string): AgentSessionState | null {
  if (!message) return null
  const lower = message.toLowerCase()
  // Anchor "permission" with surrounding context to avoid false positives like
  // "ssh: permission denied" or "Permission granted". Real Claude permission
  // prompts say things like "Claude needs your permission to use Bash".
  if (
    lower.includes('needs permission') ||
    lower.includes('your permission') ||
    lower.includes('requesting permission')
  ) {
    return 'waitingApproval'
  }
  if (lower.includes('approval')) return 'waitingApproval'
  if (lower.includes('waiting for input') || lower.includes('waiting for your input')) return 'waitingUserInput'
  return null
}

function resolveNextState(event: ClaudeHookEvent): AgentSessionState | null {
  // Note on the Stop/PermissionRequest race window: Claude Code occasionally
  // emits Stop immediately before a Notification(permission) or
  // PermissionRequest. We process events in arrival order without inspecting
  // the previous state — so a permission arriving after Stop correctly
  // overrides idle → waitingApproval. The duplicate-state suppression in
  // applyHookEvent (`if (next === entry.current) return`) is a separate
  // concern that prevents repeat emits, not transitions out of order.
  switch (event.eventType) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working'
    case 'PermissionRequest':
      return 'waitingApproval'
    case 'Notification':
      return parseNotificationMessage(event.message)
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
        entry = { current: 'unknown', lastClaudeSessionId: null, lastTranscriptPath: null }
        sessions.set(event.orchestraSessionId, entry)
      }

      entry.lastClaudeSessionId = event.claudeSessionId || entry.lastClaudeSessionId
      if (event.transcriptPath) {
        entry.lastTranscriptPath = event.transcriptPath
      }

      const next = resolveNextState(event)
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

    getLastTranscriptPath(orchestraSessionId: string): string | null {
      return sessions.get(orchestraSessionId)?.lastTranscriptPath ?? null
    },

    markNeedsUserInputIfIdle(orchestraSessionId: string): void {
      const entry = sessions.get(orchestraSessionId)
      if (!entry) return
      // Only override from idle — if the user already started a new turn,
      // the session is working and we must not clobber it.
      if (entry.current !== 'idle') return
      entry.current = 'waitingUserInput'
      emitStatus(orchestraSessionId, 'waitingUserInput')
    },
  }
}
