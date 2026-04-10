import { describe, it, expect, beforeEach } from 'vitest'
import { createClaudeSessionState, type ClaudeHookEvent } from './claude-session-state'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'

describe('claude-session-state', () => {
  let emitted: NormalizedAgentSessionStatus[]
  let state: ReturnType<typeof createClaudeSessionState>

  beforeEach(() => {
    emitted = []
    state = createClaudeSessionState({
      onStatusUpdate: (s: NormalizedAgentSessionStatus) => emitted.push(s),
    })
  })

  function fire(ev: Partial<ClaudeHookEvent>): void {
    state.applyHookEvent({
      orchestraSessionId: 'orch-1',
      claudeSessionId: 'claude-a',
      eventType: 'UserPromptSubmit',
      message: '',
      ...ev,
    } as ClaudeHookEvent)
  }

  it('UserPromptSubmit → working', () => {
    fire({ eventType: 'UserPromptSubmit' })
    expect(emitted.at(-1)?.state).toBe('working')
    expect(emitted.at(-1)?.authority).toBe('claude-hooks')
  })

  it('PreToolUse heals a missed UserPromptSubmit', () => {
    fire({ eventType: 'PreToolUse' })
    expect(emitted.at(-1)?.state).toBe('working')
  })

  it('PostToolUse keeps state working', () => {
    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'PostToolUse' })
    expect(emitted.at(-1)?.state).toBe('working')
  })

  it('PermissionRequest → waitingApproval', () => {
    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'PermissionRequest' })
    expect(emitted.at(-1)?.state).toBe('waitingApproval')
  })

  it('Notification with permission text → waitingApproval', () => {
    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'Notification', message: 'Claude needs your permission to use Bash' })
    expect(emitted.at(-1)?.state).toBe('waitingApproval')
  })

  it('Notification with waiting-for-input text → waitingUserInput', () => {
    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'Notification', message: 'Claude is waiting for your input' })
    expect(emitted.at(-1)?.state).toBe('waitingUserInput')
  })

  it('Notification with other text → no state change', () => {
    fire({ eventType: 'UserPromptSubmit' })
    const before = emitted.length
    fire({ eventType: 'Notification', message: 'Background task complete' })
    expect(emitted.length).toBe(before)
  })

  it('Stop → idle', () => {
    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'Stop' })
    expect(emitted.at(-1)?.state).toBe('idle')
  })

  it('PermissionRequest arriving right after Stop still overrides to waitingApproval', () => {
    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'Stop' })
    fire({ eventType: 'PermissionRequest' })
    expect(emitted.at(-1)?.state).toBe('waitingApproval')
  })

  it('duplicate same-state events do not re-emit', () => {
    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'PreToolUse' })
    fire({ eventType: 'PostToolUse' })
    expect(emitted.length).toBe(1)
  })

  it('onOrchestraSessionClosed clears internal state', () => {
    fire({ eventType: 'UserPromptSubmit' })
    state.onOrchestraSessionClosed('orch-1')
    emitted.length = 0
    fire({ eventType: 'PreToolUse' })
    expect(emitted.at(-1)?.state).toBe('working') // re-initialized cleanly
  })

  it('tracks latest claudeSessionId as metadata without triggering a state emit', () => {
    fire({ eventType: 'UserPromptSubmit', claudeSessionId: 'claude-a' })
    emitted.length = 0
    // Same orchestra session, new Claude session id (user ran /clear) — same state, no emit
    fire({ eventType: 'UserPromptSubmit', claudeSessionId: 'claude-b' })
    expect(emitted.length).toBe(0)
    expect(state.getLastClaudeSessionId('orch-1')).toBe('claude-b')
  })

  it('does NOT match unrelated "permission" mentions in notifications', () => {
    fire({ eventType: 'UserPromptSubmit' })
    emitted.length = 0
    fire({ eventType: 'Notification', message: 'ssh: permission denied' })
    expect(emitted.length).toBe(0)
    fire({ eventType: 'Notification', message: 'Permission granted' })
    expect(emitted.length).toBe(0)
    fire({ eventType: 'Notification', message: 'file permission error' })
    expect(emitted.length).toBe(0)
  })

  it('isolates state across multiple Orchestra sessions in one state machine instance', () => {
    state.applyHookEvent({
      orchestraSessionId: 'orch-1',
      claudeSessionId: 'claude-a',
      eventType: 'UserPromptSubmit',
      message: '',
    })
    state.applyHookEvent({
      orchestraSessionId: 'orch-2',
      claudeSessionId: 'claude-b',
      eventType: 'Stop',
      message: '',
    })
    expect(state.getCurrentState('orch-1')).toBe('working')
    expect(state.getCurrentState('orch-2')).toBe('idle')

    // Closing one session must not affect the other
    state.onOrchestraSessionClosed('orch-1')
    expect(state.getCurrentState('orch-1')).toBe(null)
    expect(state.getCurrentState('orch-2')).toBe('idle')
  })
})
