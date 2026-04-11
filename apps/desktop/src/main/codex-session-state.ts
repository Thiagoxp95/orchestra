// Event-sourced state machine: Orchestra Codex wrapper events ->
// NormalizedAgentSessionStatus updates. Authority: 'codex-watcher-fallback'.

import type { AgentSessionState, NormalizedAgentSessionStatus } from '../shared/agent-session-types'
import type { CodexHookEventType } from './codex-hook-runtime'

export interface CodexHookEvent {
  orchestraSessionId: string
  eventType: CodexHookEventType
}

interface PerSessionState {
  current: AgentSessionState
}

export interface CodexSessionStateOptions {
  onStatusUpdate: (status: NormalizedAgentSessionStatus) => void
}

export interface CodexSessionState {
  applyHookEvent(event: CodexHookEvent): void
  onOrchestraSessionClosed(orchestraSessionId: string): void
  getCurrentState(orchestraSessionId: string): AgentSessionState | null
}

function resolveNextState(event: CodexHookEvent): AgentSessionState {
  switch (event.eventType) {
    case 'Start':
      return 'working'
    case 'PermissionRequest':
      return 'waitingApproval'
    case 'UserInputRequest':
      return 'waitingUserInput'
    case 'Stop':
      return 'idle'
  }
}

export function createCodexSessionState(opts: CodexSessionStateOptions): CodexSessionState {
  const sessions = new Map<string, PerSessionState>()

  function emitStatus(orchestraSessionId: string, next: AgentSessionState): void {
    const now = Date.now()
    const status: NormalizedAgentSessionStatus = {
      sessionId: orchestraSessionId,
      agent: 'codex',
      state: next,
      authority: 'codex-watcher-fallback',
      connected: true,
      lastResponsePreview: '',
      lastTransitionAt: now,
      updatedAt: now,
    }
    opts.onStatusUpdate(status)
  }

  return {
    applyHookEvent(event: CodexHookEvent): void {
      let entry = sessions.get(event.orchestraSessionId)
      if (!entry) {
        entry = { current: 'unknown' }
        sessions.set(event.orchestraSessionId, entry)
      }

      const next = resolveNextState(event)
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
  }
}
