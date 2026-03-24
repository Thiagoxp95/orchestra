import { describe, expect, it, beforeEach } from 'vitest'
import {
  AgentSessionRegistry,
  mapClaudeHookToState,
  mapCodexThreadStatusToState,
} from './agent-session-authority'

describe('mapClaudeHookToState', () => {
  it('maps Start to working', () => {
    expect(mapClaudeHookToState('Start')).toBe('working')
  })

  it('maps Stop to idle', () => {
    expect(mapClaudeHookToState('Stop')).toBe('idle')
  })

  it('maps PermissionRequest to waitingApproval', () => {
    expect(mapClaudeHookToState('PermissionRequest')).toBe('waitingApproval')
  })
})

describe('mapCodexThreadStatusToState', () => {
  it('maps idle to idle', () => {
    expect(mapCodexThreadStatusToState({ type: 'idle' })).toBe('idle')
  })

  it('maps active to working', () => {
    expect(mapCodexThreadStatusToState({ type: 'active', activeFlags: [] })).toBe('working')
  })

  it('maps active with waitingOnApproval to waitingApproval', () => {
    expect(mapCodexThreadStatusToState({ type: 'active', activeFlags: ['waitingOnApproval'] })).toBe('waitingApproval')
  })

  it('maps active with waitingOnUserInput to waitingUserInput', () => {
    expect(mapCodexThreadStatusToState({ type: 'active', activeFlags: ['waitingOnUserInput'] })).toBe('waitingUserInput')
  })

  it('maps systemError to error', () => {
    expect(mapCodexThreadStatusToState({ type: 'systemError' })).toBe('error')
  })

  it('maps notLoaded to unknown', () => {
    expect(mapCodexThreadStatusToState({ type: 'notLoaded' })).toBe('unknown')
  })
})

describe('AgentSessionRegistry', () => {
  let registry: AgentSessionRegistry
  let emitted: Array<{ sessionId: string; status: any }>

  beforeEach(() => {
    emitted = []
    registry = new AgentSessionRegistry((sessionId, status) => {
      emitted.push({ sessionId, status })
    })
  })

  it('registers a session and returns default status', () => {
    registry.register('s1', 'claude')
    const status = registry.get('s1')
    expect(status?.agent).toBe('claude')
    expect(status?.state).toBe('unknown')
    expect(status?.authority).toBe('claude-hooks')
  })

  it('transitions state and emits', () => {
    registry.register('s1', 'claude')
    registry.transition('s1', 'working', 'claude-hooks')
    expect(registry.get('s1')?.state).toBe('working')
    expect(emitted.length).toBe(1)
    expect(emitted[0].status.state).toBe('working')
  })

  it('does not emit when state is unchanged', () => {
    registry.register('s1', 'claude')
    registry.transition('s1', 'working', 'claude-hooks')
    registry.transition('s1', 'working', 'claude-hooks')
    expect(emitted.length).toBe(1)
  })

  it('authoritative source wins over fallback', () => {
    registry.register('s1', 'claude')
    registry.transition('s1', 'working', 'claude-hooks')
    // Fallback tries to set idle — should be rejected because hooks are fresher
    registry.transitionFallback('s1', 'idle', 'claude-watcher-fallback')
    expect(registry.get('s1')?.state).toBe('working')
    expect(registry.get('s1')?.authority).toBe('claude-hooks')
  })

  it('fallback can set state when authority is absent', () => {
    registry.register('s1', 'claude')
    // No authoritative transition yet — fallback can set state
    registry.transitionFallback('s1', 'working', 'claude-watcher-fallback')
    expect(registry.get('s1')?.state).toBe('working')
    expect(registry.get('s1')?.authority).toBe('claude-watcher-fallback')
  })

  it('fallback takes over after authority goes stale', () => {
    registry.register('s1', 'claude')
    registry.transition('s1', 'working', 'claude-hooks')

    // Simulate time passing — make the last transition stale
    const status = registry.get('s1')!
    ;(status as any).lastTransitionAt = Date.now() - 120_000

    registry.transitionFallback('s1', 'idle', 'claude-watcher-fallback')
    expect(registry.get('s1')?.state).toBe('idle')
  })

  it('unregisters a session', () => {
    registry.register('s1', 'claude')
    registry.unregister('s1')
    expect(registry.get('s1')).toBeUndefined()
  })

  it('degrades a session', () => {
    registry.register('s1', 'codex')
    registry.degrade('s1', 'codex-watcher-fallback', 'app-server disconnected')
    const status = registry.get('s1')
    expect(status?.connected).toBe(false)
    expect(status?.degradedReason).toBe('app-server disconnected')
    expect(status?.authority).toBe('codex-watcher-fallback')
  })

  it('updates response preview without changing state', () => {
    registry.register('s1', 'claude')
    registry.updateResponsePreview('s1', 'Hello world')
    expect(registry.get('s1')?.lastResponsePreview).toBe('Hello world')
  })

  it('getAll returns all registered sessions', () => {
    registry.register('s1', 'claude')
    registry.register('s2', 'codex')
    expect(registry.getAll()).toHaveLength(2)
  })
})

describe('Claude hook authority integration', () => {
  let registry: AgentSessionRegistry
  let emitted: Array<{ sessionId: string; status: any }>

  beforeEach(() => {
    emitted = []
    registry = new AgentSessionRegistry((sessionId, status) => {
      emitted.push({ sessionId, status })
    })
  })

  it('Start -> PermissionRequest -> Stop yields working -> waitingApproval -> idle', () => {
    registry.register('s1', 'claude')

    registry.transition('s1', mapClaudeHookToState('Start'), 'claude-hooks')
    expect(registry.get('s1')?.state).toBe('working')

    registry.transition('s1', mapClaudeHookToState('PermissionRequest'), 'claude-hooks')
    expect(registry.get('s1')?.state).toBe('waitingApproval')

    registry.transition('s1', mapClaudeHookToState('Stop'), 'claude-hooks')
    expect(registry.get('s1')?.state).toBe('idle')
  })

  it('fresh hook events cannot be overridden by watcher fallback', () => {
    registry.register('s1', 'claude')
    registry.transition('s1', 'working', 'claude-hooks')

    registry.transitionFallback('s1', 'idle', 'claude-watcher-fallback')
    expect(registry.get('s1')?.state).toBe('working')
    expect(registry.get('s1')?.authority).toBe('claude-hooks')
  })

  it('missing hooks allow fallback recovery', () => {
    registry.register('s1', 'claude')
    registry.transitionFallback('s1', 'working', 'claude-watcher-fallback')
    expect(registry.get('s1')?.state).toBe('working')
    expect(registry.get('s1')?.authority).toBe('claude-watcher-fallback')
  })
})

describe('Codex app-server authority', () => {
  let registry: AgentSessionRegistry
  let emitted: Array<{ sessionId: string; status: any }>

  beforeEach(() => {
    emitted = []
    registry = new AgentSessionRegistry((sessionId, status) => {
      emitted.push({ sessionId, status })
    })
  })

  it('thread/status/changed drives working -> waitingApproval -> waitingUserInput -> idle', () => {
    registry.register('s1', 'codex')

    registry.transition('s1', mapCodexThreadStatusToState({ type: 'active', activeFlags: [] }), 'codex-app-server')
    expect(registry.get('s1')?.state).toBe('working')

    registry.transition('s1', mapCodexThreadStatusToState({ type: 'active', activeFlags: ['waitingOnApproval'] }), 'codex-app-server')
    expect(registry.get('s1')?.state).toBe('waitingApproval')

    registry.transition('s1', mapCodexThreadStatusToState({ type: 'active', activeFlags: ['waitingOnUserInput'] }), 'codex-app-server')
    expect(registry.get('s1')?.state).toBe('waitingUserInput')

    registry.transition('s1', mapCodexThreadStatusToState({ type: 'idle' }), 'codex-app-server')
    expect(registry.get('s1')?.state).toBe('idle')
  })

  it('app-server disconnect degrades to watcher fallback', () => {
    registry.register('s1', 'codex')
    registry.transition('s1', 'working', 'codex-app-server')

    registry.degrade('s1', 'codex-watcher-fallback', 'app-server disconnected')

    const status = registry.get('s1')
    expect(status?.connected).toBe(false)
    expect(status?.degradedReason).toBe('app-server disconnected')
    expect(status?.authority).toBe('codex-watcher-fallback')
    expect(status?.state).toBe('working')
  })

  it('after degrade, watcher fallback can update state', () => {
    registry.register('s1', 'codex')
    registry.transition('s1', 'working', 'codex-app-server')
    registry.degrade('s1', 'codex-watcher-fallback', 'disconnected')

    registry.transitionFallback('s1', 'idle', 'codex-watcher-fallback')
    expect(registry.get('s1')?.state).toBe('idle')
  })
})
