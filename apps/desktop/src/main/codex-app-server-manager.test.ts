import { describe, expect, it } from 'vitest'
import {
  CodexAppServerManager,
  mapCodexNotificationToState,
} from './codex-app-server-manager'

describe('mapCodexNotificationToState', () => {
  it('maps idle status', () => {
    expect(mapCodexNotificationToState({ type: 'idle' })).toBe('idle')
  })

  it('maps active with approval flag', () => {
    expect(mapCodexNotificationToState({ type: 'active', activeFlags: ['waitingOnApproval'] })).toBe('waitingApproval')
  })

  it('maps active with input flag', () => {
    expect(mapCodexNotificationToState({ type: 'active', activeFlags: ['waitingOnUserInput'] })).toBe('waitingUserInput')
  })

  it('maps active without flags to working', () => {
    expect(mapCodexNotificationToState({ type: 'active', activeFlags: [] })).toBe('working')
  })
})

describe('CodexAppServerManager', () => {
  it('stores and retrieves thread-session mapping', () => {
    const manager = new CodexAppServerManager()
    manager.mapSession('sess-1', 'thread-abc')

    expect(manager.getThreadIdForSession('sess-1')).toBe('thread-abc')
    expect(manager.getSessionIdForThread('thread-abc')).toBe('sess-1')
  })

  it('cleans up mapping on unmap', () => {
    const manager = new CodexAppServerManager()
    manager.mapSession('sess-1', 'thread-abc')
    manager.unmapSession('sess-1')

    expect(manager.getThreadIdForSession('sess-1')).toBeUndefined()
    expect(manager.getSessionIdForThread('thread-abc')).toBeUndefined()
  })
})
