import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSleepBlocker } from './agent-sleep-blocker'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'

function buildStatus(
  overrides: Partial<NormalizedAgentSessionStatus> = {},
): NormalizedAgentSessionStatus {
  const now = Date.now()
  return {
    sessionId: 'session-1',
    agent: 'codex',
    state: 'idle',
    authority: 'codex-hook',
    connected: true,
    lastResponsePreview: '',
    lastTransitionAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('AgentSleepBlocker', () => {
  const start = vi.fn(() => 42)
  const stop = vi.fn()
  const isStarted = vi.fn(() => true)

  beforeEach(() => {
    start.mockClear()
    stop.mockClear()
    isStarted.mockClear()
    isStarted.mockReturnValue(true)
  })

  function createBlocker(): AgentSleepBlocker {
    return new AgentSleepBlocker({
      powerSaveBlocker: { start, stop, isStarted },
    })
  }

  it('holds a display sleep blocker while a Codex session is working', () => {
    const blocker = createBlocker()

    blocker.updateNormalizedStatus(buildStatus({ state: 'working' }))

    expect(start).toHaveBeenCalledWith('prevent-display-sleep')
    expect(stop).not.toHaveBeenCalled()

    blocker.updateNormalizedStatus(buildStatus({ state: 'idle' }))

    expect(stop).toHaveBeenCalledWith(42)
  })

  it('keeps the blocker active until every tracked agent session is idle', () => {
    const blocker = createBlocker()

    blocker.updateNormalizedStatus(buildStatus({ sessionId: 'codex-1', state: 'working' }))
    blocker.updateClaudeWorkState('claude-1', 'working')
    blocker.updateNormalizedStatus(buildStatus({ sessionId: 'codex-1', state: 'idle' }))

    expect(stop).not.toHaveBeenCalled()

    blocker.updateClaudeWorkState('claude-1', 'idle')

    expect(stop).toHaveBeenCalledWith(42)
  })

  it('clears only normalized state without dropping active Claude work for the same session', () => {
    const blocker = createBlocker()

    blocker.updateNormalizedStatus(buildStatus({ sessionId: 'session-1', state: 'working' }))
    blocker.updateClaudeWorkState('session-1', 'working')
    blocker.clearNormalizedStatus('session-1')

    expect(stop).not.toHaveBeenCalled()

    blocker.updateClaudeWorkState('session-1', 'idle')

    expect(stop).toHaveBeenCalledWith(42)
  })

  it('treats Codex approval and user-input states as active work', () => {
    const blocker = createBlocker()

    blocker.updateNormalizedStatus(buildStatus({ state: 'waitingApproval' }))
    blocker.updateNormalizedStatus(buildStatus({ state: 'waitingUserInput' }))

    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
  })

  it('does not hold a blocker for unknown, idle, error, or disconnected Codex state', () => {
    const blocker = createBlocker()

    blocker.updateNormalizedStatus(buildStatus({ sessionId: 'unknown', state: 'unknown' }))
    blocker.updateNormalizedStatus(buildStatus({ sessionId: 'idle', state: 'idle' }))
    blocker.updateNormalizedStatus(buildStatus({ sessionId: 'error', state: 'error' }))
    blocker.updateNormalizedStatus(buildStatus({ sessionId: 'disconnected', state: 'working', connected: false }))

    expect(start).not.toHaveBeenCalled()
  })

  it('holds while Claude reports working and releases when Claude returns idle', () => {
    const blocker = createBlocker()

    blocker.updateClaudeWorkState('claude-1', 'working')
    blocker.updateClaudeWorkState('claude-1', 'idle')

    expect(start).toHaveBeenCalledWith('prevent-display-sleep')
    expect(stop).toHaveBeenCalledWith(42)
  })

  it('holds for Cursor process sessions until they return to terminal', () => {
    const blocker = createBlocker()

    blocker.updateProcessStatus('cursor-1', 'cursor')
    blocker.updateProcessStatus('cursor-1', 'terminal')

    expect(start).toHaveBeenCalledWith('prevent-display-sleep')
    expect(stop).toHaveBeenCalledWith(42)
  })

  it('stops the underlying blocker and clears tracked sessions on stop', () => {
    const blocker = createBlocker()

    blocker.updateNormalizedStatus(buildStatus({ state: 'working' }))
    blocker.stop()
    blocker.updateNormalizedStatus(buildStatus({ state: 'idle' }))

    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith(42)
  })
})
