import { describe, expect, it } from 'vitest'
import { computeAgentView } from './agent-view-state'
import type { NormalizedAgentSessionStatus } from '../../../shared/agent-session-types'

function normalized(
  partial: Partial<NormalizedAgentSessionStatus> & { state: NormalizedAgentSessionStatus['state'] },
): NormalizedAgentSessionStatus {
  return {
    sessionId: 's1',
    agent: 'codex',
    authority: 'codex-app-server',
    connected: true,
    lastResponsePreview: '',
    lastTransitionAt: 0,
    updatedAt: 0,
    ...partial,
  }
}

describe('computeAgentView', () => {
  it('returns a non-agent view when process status is terminal', () => {
    const view = computeAgentView({
      processStatus: 'terminal',
      sessionNeedsUserInput: false,
    })
    expect(view.isAgent).toBe(false)
    expect(view.isWorking).toBe(false)
    expect(view.needsInput).toBe(false)
    expect(view.needsApproval).toBe(false)
    expect(view.isIdle).toBe(false)
  })

  describe('claude', () => {
    it('trusts normalized state when connected', () => {
      const view = computeAgentView({
        processStatus: 'claude',
        normalizedState: normalized({ agent: 'claude', state: 'working' }),
        claudeWorkState: 'idle',
        sessionNeedsUserInput: false,
      })
      expect(view.isWorking).toBe(true)
      expect(view.isIdle).toBe(false)
    })

    it('falls back to claudeWorkState when normalized missing', () => {
      const view = computeAgentView({
        processStatus: 'claude',
        claudeWorkState: 'working',
        sessionNeedsUserInput: false,
      })
      expect(view.isWorking).toBe(true)
    })

    it('reports needsInput from sessionNeedsUserInput flag', () => {
      const view = computeAgentView({
        processStatus: 'claude',
        claudeWorkState: 'idle',
        sessionNeedsUserInput: true,
      })
      expect(view.needsInput).toBe(true)
      expect(view.isIdle).toBe(false)
    })
  })

  describe('codex', () => {
    it('reports working when normalized.state is working', () => {
      const view = computeAgentView({
        processStatus: 'codex',
        normalizedState: normalized({ state: 'working' }),
        codexWorkState: 'idle',
        sessionNeedsUserInput: false,
      })
      expect(view.isWorking).toBe(true)
    })

    it('reports waitingUserInput from normalized state', () => {
      const view = computeAgentView({
        processStatus: 'codex',
        normalizedState: normalized({ state: 'waitingUserInput' }),
        sessionNeedsUserInput: false,
      })
      expect(view.needsInput).toBe(true)
      expect(view.isWorking).toBe(false)
    })

    it('reports waitingApproval from normalized state', () => {
      const view = computeAgentView({
        processStatus: 'codex',
        normalizedState: normalized({ state: 'waitingApproval' }),
        sessionNeedsUserInput: false,
      })
      expect(view.needsApproval).toBe(true)
      expect(view.isWorking).toBe(false)
    })

    it('does NOT report working based on stale codexWorkState when normalized is absent', () => {
      const view = computeAgentView({
        processStatus: 'codex',
        codexWorkState: 'working',
        sessionNeedsUserInput: false,
      })
      expect(view.isWorking).toBe(false)
      expect(view.isIdle).toBe(true)
    })

    it('does NOT report waitingUserInput based on stale codexWorkState when normalized is absent', () => {
      const view = computeAgentView({
        processStatus: 'codex',
        codexWorkState: 'waitingUserInput',
        sessionNeedsUserInput: false,
      })
      expect(view.needsInput).toBe(false)
    })

    it('still honors sessionNeedsUserInput (from idle-notifier) when normalized is absent', () => {
      const view = computeAgentView({
        processStatus: 'codex',
        codexWorkState: 'working',
        sessionNeedsUserInput: true,
      })
      expect(view.needsInput).toBe(true)
      expect(view.isWorking).toBe(false)
      expect(view.isIdle).toBe(false)
    })

    it('treats codex as idle when no normalized and no session flags', () => {
      const view = computeAgentView({
        processStatus: 'codex',
        sessionNeedsUserInput: false,
      })
      expect(view.isIdle).toBe(true)
      expect(view.isWorking).toBe(false)
      expect(view.needsInput).toBe(false)
    })

    it('falls back to idle when normalized present but disconnected', () => {
      const view = computeAgentView({
        processStatus: 'codex',
        normalizedState: normalized({ state: 'working', connected: false, degradedReason: 'disconnected' }),
        codexWorkState: 'working',
        sessionNeedsUserInput: false,
      })
      expect(view.isWorking).toBe(false)
      expect(view.isIdle).toBe(true)
    })
  })
})
