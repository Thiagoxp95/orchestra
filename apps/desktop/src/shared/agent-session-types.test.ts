import { describe, expect, it } from 'vitest'
import {
  isAgentSessionState,
  isAgentSessionAuthority,
  createDefaultNormalizedStatus,
} from './agent-session-types'

describe('isAgentSessionState', () => {
  it('accepts valid states', () => {
    for (const state of ['unknown', 'working', 'waitingApproval', 'waitingUserInput', 'idle', 'error']) {
      expect(isAgentSessionState(state)).toBe(true)
    }
  })

  it('rejects invalid values', () => {
    expect(isAgentSessionState('busy')).toBe(false)
    expect(isAgentSessionState(null)).toBe(false)
  })
})

describe('isAgentSessionAuthority', () => {
  it('accepts valid authorities', () => {
    for (const auth of ['codex-app-server', 'claude-hooks', 'codex-watcher-fallback', 'claude-watcher-fallback']) {
      expect(isAgentSessionAuthority(auth)).toBe(true)
    }
  })

  it('rejects invalid values', () => {
    expect(isAgentSessionAuthority('magic')).toBe(false)
  })
})

describe('createDefaultNormalizedStatus', () => {
  it('creates an unknown status for claude', () => {
    const status = createDefaultNormalizedStatus('sess-1', 'claude')
    expect(status.sessionId).toBe('sess-1')
    expect(status.agent).toBe('claude')
    expect(status.state).toBe('unknown')
    expect(status.authority).toBe('claude-hooks')
    expect(status.connected).toBe(true)
  })

  it('creates an unknown status for codex', () => {
    const status = createDefaultNormalizedStatus('sess-2', 'codex')
    expect(status.authority).toBe('codex-app-server')
  })
})
