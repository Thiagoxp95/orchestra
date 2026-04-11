import { beforeEach, describe, expect, it } from 'vitest'
import { createCodexSessionState, type CodexHookEvent } from './codex-session-state'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'

describe('codex-session-state', () => {
  let emitted: NormalizedAgentSessionStatus[]
  let state: ReturnType<typeof createCodexSessionState>

  beforeEach(() => {
    emitted = []
    state = createCodexSessionState({
      onStatusUpdate: (status) => emitted.push(status),
    })
  })

  function fire(event: Partial<CodexHookEvent>): void {
    state.applyHookEvent({
      orchestraSessionId: 'orch-1',
      eventType: 'Start',
      ...event,
    } as CodexHookEvent)
  }

  it('Start -> working', () => {
    fire({ eventType: 'Start' })
    expect(emitted.at(-1)?.state).toBe('working')
    expect(emitted.at(-1)?.authority).toBe('codex-watcher-fallback')
  })

  it('PermissionRequest -> waitingApproval', () => {
    fire({ eventType: 'Start' })
    fire({ eventType: 'PermissionRequest' })
    expect(emitted.at(-1)?.state).toBe('waitingApproval')
  })

  it('UserInputRequest -> waitingUserInput', () => {
    fire({ eventType: 'Start' })
    fire({ eventType: 'UserInputRequest' })
    expect(emitted.at(-1)?.state).toBe('waitingUserInput')
  })

  it('Stop -> idle', () => {
    fire({ eventType: 'Start' })
    fire({ eventType: 'Stop' })
    expect(emitted.at(-1)?.state).toBe('idle')
  })

  it('PermissionRequest arriving after Stop overrides back to waitingApproval', () => {
    fire({ eventType: 'Start' })
    fire({ eventType: 'Stop' })
    fire({ eventType: 'PermissionRequest' })
    expect(emitted.at(-1)?.state).toBe('waitingApproval')
  })

  it('dedupes repeated same-state events', () => {
    fire({ eventType: 'Start' })
    fire({ eventType: 'Start' })
    expect(emitted).toHaveLength(1)
  })

  it('clears internal state when the Orchestra session closes', () => {
    fire({ eventType: 'Start' })
    state.onOrchestraSessionClosed('orch-1')
    emitted.length = 0
    fire({ eventType: 'Stop' })
    expect(emitted.at(-1)?.state).toBe('idle')
  })

  it('isolates state across multiple Orchestra sessions', () => {
    state.applyHookEvent({
      orchestraSessionId: 'orch-1',
      eventType: 'Start',
    })
    state.applyHookEvent({
      orchestraSessionId: 'orch-2',
      eventType: 'UserInputRequest',
    })

    expect(state.getCurrentState('orch-1')).toBe('working')
    expect(state.getCurrentState('orch-2')).toBe('waitingUserInput')
  })
})
