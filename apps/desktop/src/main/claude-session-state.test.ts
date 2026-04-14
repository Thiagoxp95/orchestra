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

  it('UserPromptSubmit → working with turn-started and a fresh turnId', () => {
    fire({ eventType: 'UserPromptSubmit' })
    const last = emitted.at(-1)
    expect(last?.state).toBe('working')
    expect(last?.authority).toBe('claude-hooks')
    expect(last?.transition).toBe('turn-started')
    expect(typeof last?.turnId).toBe('string')
    expect((last?.turnId ?? '').length).toBeGreaterThan(0)
  })

  it('PreToolUse without an active turn autonomously starts a turn', () => {
    fire({ eventType: 'PreToolUse' })
    const last = emitted.at(-1)
    expect(last?.state).toBe('working')
    expect(last?.transition).toBe('turn-started')
    expect(typeof last?.turnId).toBe('string')
  })

  it('PostToolUse inside a working turn does not re-emit', () => {
    fire({ eventType: 'UserPromptSubmit' })
    const before = emitted.length
    fire({ eventType: 'PostToolUse' })
    expect(emitted.length).toBe(before)
  })

  it('PermissionRequest mid-turn emits an attention edge on the SAME turnId', () => {
    fire({ eventType: 'UserPromptSubmit' })
    const turnId = emitted.at(-1)?.turnId
    fire({ eventType: 'PermissionRequest' })
    const last = emitted.at(-1)
    expect(last?.state).toBe('waitingApproval')
    expect(last?.transition).toBe('attention')
    expect(last?.turnId).toBe(turnId)
  })

  it('Notification permission text → attention waitingApproval', () => {
    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'Notification', message: 'Claude needs your permission to use Bash' })
    const last = emitted.at(-1)
    expect(last?.state).toBe('waitingApproval')
    expect(last?.transition).toBe('attention')
  })

  it('Notification with waiting-for-input text → attention waitingUserInput', () => {
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

  it('Stop closes the current turn and emits turn-ended', () => {
    fire({ eventType: 'UserPromptSubmit' })
    const turnId = emitted.at(-1)?.turnId
    fire({ eventType: 'Stop' })
    const last = emitted.at(-1)
    expect(last?.state).toBe('idle')
    expect(last?.transition).toBe('turn-ended')
    expect(last?.turnId).toBe(turnId)
  })

  it('Stop with a mismatched expectedTurnId is dropped', () => {
    fire({ eventType: 'UserPromptSubmit' })
    const before = emitted.length
    fire({ eventType: 'Stop', expectedTurnId: 'not-the-real-turn' })
    expect(emitted.length).toBe(before)
    expect(state.getCurrentState('orch-1')).toBe('working')
  })

  it('Stop with a matching expectedTurnId closes the turn', () => {
    fire({ eventType: 'UserPromptSubmit' })
    const turnId = state.getCurrentTurnId('orch-1')!
    fire({ eventType: 'Stop', expectedTurnId: turnId })
    expect(emitted.at(-1)?.state).toBe('idle')
    expect(emitted.at(-1)?.transition).toBe('turn-ended')
  })

  it('Stop with no active turn does not emit (no zero-turn idle)', () => {
    // No UserPromptSubmit yet — session is unknown with no turn.
    const before = emitted.length
    fire({ eventType: 'Stop' })
    expect(emitted.length).toBe(before)
  })

  it('a fresh UserPromptSubmit after a Stop mints a new turnId', () => {
    fire({ eventType: 'UserPromptSubmit' })
    const turn1 = emitted.at(-1)?.turnId
    fire({ eventType: 'Stop' })
    fire({ eventType: 'UserPromptSubmit' })
    const turn2 = emitted.at(-1)?.turnId
    expect(turn2).not.toBe(turn1)
    expect(emitted.at(-1)?.transition).toBe('turn-started')
  })

  it('noteInterrupt closes the current turn and tags it wasInterrupted', () => {
    fire({ eventType: 'UserPromptSubmit' })
    const turn1 = emitted.at(-1)?.turnId
    state.noteInterrupt('orch-1')
    const last = emitted.at(-1)
    expect(last?.state).toBe('idle')
    expect(last?.transition).toBe('turn-ended')
    expect(last?.turnId).toBe(turn1)
    expect(last?.wasInterrupted).toBe(true)
  })

  it('noteInterrupt is a no-op when the session is not in a live turn', () => {
    const before = emitted.length
    state.noteInterrupt('orch-1') // unknown session — no-op
    expect(emitted.length).toBe(before)

    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'Stop' })
    const afterStop = emitted.length
    state.noteInterrupt('orch-1') // already idle — no-op
    expect(emitted.length).toBe(afterStop)
  })

  it('a real Stop arriving after noteInterrupt is suppressed (turn already closed)', () => {
    fire({ eventType: 'UserPromptSubmit' })
    state.noteInterrupt('orch-1')
    const afterInterrupt = emitted.length
    fire({ eventType: 'Stop' })
    expect(emitted.length).toBe(afterInterrupt)
  })

  it('onOrchestraSessionClosed clears internal state', () => {
    fire({ eventType: 'UserPromptSubmit' })
    state.onOrchestraSessionClosed('orch-1')
    emitted.length = 0
    fire({ eventType: 'PreToolUse' })
    expect(emitted.at(-1)?.state).toBe('working') // re-initialized cleanly
    expect(emitted.at(-1)?.transition).toBe('turn-started')
  })

  it('tracks latest claudeSessionId as metadata across turns', () => {
    fire({ eventType: 'UserPromptSubmit', claudeSessionId: 'claude-a' })
    fire({ eventType: 'UserPromptSubmit', claudeSessionId: 'claude-b' })
    expect(state.getLastClaudeSessionId('orch-1')).toBe('claude-b')
  })

  it('does NOT match unrelated "permission" mentions in notifications', () => {
    fire({ eventType: 'UserPromptSubmit' })
    const before = emitted.length
    fire({ eventType: 'Notification', message: 'ssh: permission denied' })
    fire({ eventType: 'Notification', message: 'Permission granted' })
    fire({ eventType: 'Notification', message: 'file permission error' })
    expect(emitted.length).toBe(before)
  })

  it('isolates state across multiple Orchestra sessions', () => {
    state.applyHookEvent({
      orchestraSessionId: 'orch-1',
      claudeSessionId: 'claude-a',
      eventType: 'UserPromptSubmit',
      message: '',
    })
    state.applyHookEvent({
      orchestraSessionId: 'orch-2',
      claudeSessionId: 'claude-b',
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

    state.onOrchestraSessionClosed('orch-1')
    expect(state.getCurrentState('orch-1')).toBe(null)
    expect(state.getCurrentState('orch-2')).toBe('idle')
  })

  it('markNeedsUserInputIfIdle promotes idle → waitingUserInput on the same turn', () => {
    fire({ eventType: 'UserPromptSubmit' })
    const turnId = emitted.at(-1)?.turnId
    fire({ eventType: 'Stop' })
    expect(emitted.at(-1)?.state).toBe('idle')
    state.markNeedsUserInputIfIdle('orch-1')
    const last = emitted.at(-1)
    expect(last?.state).toBe('waitingUserInput')
    expect(last?.transition).toBe('attention')
    // Critical: same turnId as the closed turn, so the notifier knows this
    // is a post-hoc classifier promotion, not a fresh turn.
    expect(last?.turnId).toBe(turnId)
  })
})
