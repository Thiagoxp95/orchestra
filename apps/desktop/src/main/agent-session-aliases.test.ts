import { afterEach, describe, expect, it } from 'vitest'
import {
  clearAgentSessionAlias,
  clearAllAgentSessionAliases,
  registerAgentSessionAlias,
  resolveAgentActualSessionId,
  resolveAgentProcessSessionId,
} from './agent-session-aliases'

afterEach(() => {
  clearAllAgentSessionAliases()
})

describe('agent session aliases', () => {
  it('falls back to the real session id when no alias exists', () => {
    expect(resolveAgentProcessSessionId('session-1')).toBe('session-1')
    expect(resolveAgentActualSessionId('session-1')).toBe('session-1')
  })

  it('maps a claimed warm process session id back to the actual session id', () => {
    registerAgentSessionAlias('session-actual', '__warm-agent__:claude:123')

    expect(resolveAgentProcessSessionId('session-actual')).toBe('__warm-agent__:claude:123')
    expect(resolveAgentActualSessionId('__warm-agent__:claude:123')).toBe('session-actual')
  })

  it('replaces any previous owner when a warm process is reassigned', () => {
    registerAgentSessionAlias('session-a', '__warm-agent__:codex:123')
    registerAgentSessionAlias('session-b', '__warm-agent__:codex:123')

    expect(resolveAgentActualSessionId('__warm-agent__:codex:123')).toBe('session-b')
    expect(resolveAgentProcessSessionId('session-a')).toBe('session-a')
  })

  it('clears both directions of the alias mapping', () => {
    registerAgentSessionAlias('session-actual', '__warm-agent__:claude:123')
    clearAgentSessionAlias('session-actual')

    expect(resolveAgentProcessSessionId('session-actual')).toBe('session-actual')
    expect(resolveAgentActualSessionId('__warm-agent__:claude:123')).toBe('__warm-agent__:claude:123')
  })
})
