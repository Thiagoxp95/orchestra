import { describe, expect, it } from 'vitest'
import {
  CodexAppServerManager,
  mapCodexNotificationToState,
} from './codex-app-server-manager'

function makeManager() {
  return new CodexAppServerManager({
    client: {
      request: async <T>() => ({} as T),
      getRemoteUrl: () => null,
      stop: () => {},
    },
  })
}

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
    const manager = makeManager()
    manager.mapSession('sess-1', 'thread-abc')

    expect(manager.getThreadIdForSession('sess-1')).toBe('thread-abc')
    expect(manager.getSessionIdForThread('thread-abc')).toBe('sess-1')
  })

  it('cleans up mapping on unmap', async () => {
    const manager = makeManager()
    manager.mapSession('sess-1', 'thread-abc')
    await manager.unmapSession('sess-1')

    expect(manager.getThreadIdForSession('sess-1')).toBeUndefined()
    expect(manager.getSessionIdForThread('thread-abc')).toBeUndefined()
  })

  it('coalesces concurrent createThread calls for the same session', async () => {
    const calls: { method: string; params: unknown }[] = []
    let threadCounter = 0
    const manager = new CodexAppServerManager({
      client: {
        request: async <T>(method: string, params: unknown): Promise<T> => {
          calls.push({ method, params })
          if (method === 'thread/start') {
            const id = `thread-${++threadCounter}`
            return { thread: { id, status: { type: 'notLoaded' } } } as unknown as T
          }
          if (method === 'thread/read') {
            throw new Error('thread is not materialized yet; includeTurns is unavailable before first user message')
          }
          return {} as T
        },
        getRemoteUrl: () => null,
        stop: () => {},
      },
    })

    const results = await Promise.all([
      manager.createThread('sess-1', '/tmp'),
      manager.createThread('sess-1', '/tmp'),
      manager.createThread('sess-1', '/tmp'),
      manager.createThread('sess-1', '/tmp'),
    ])

    expect(new Set(results).size).toBe(1)
    expect(results[0]).toBe('thread-1')
    expect(calls.filter((c) => c.method === 'thread/start')).toHaveLength(1)
  })

  it('does not emit disconnected status for "not materialized yet" errors', async () => {
    const updates: Array<{ state: string; connected: boolean }> = []
    const manager = new CodexAppServerManager({
      client: {
        request: async <T>(method: string): Promise<T> => {
          if (method === 'thread/start') {
            return { thread: { id: 'thread-1', status: { type: 'active', activeFlags: [] } } } as unknown as T
          }
          if (method === 'thread/read') {
            throw new Error('thread thread-1 is not materialized yet; includeTurns is unavailable before first user message')
          }
          return {} as T
        },
        getRemoteUrl: () => null,
        stop: () => {},
      },
      onStatusUpdate: (status) => {
        updates.push({ state: status.state, connected: status.connected })
      },
    })

    await manager.createThread('sess-1', '/tmp')
    await manager.refreshSession('sess-1')

    expect(updates.some((u) => !u.connected)).toBe(false)
  })

  it('runs start() exactly once under concurrent callers', async () => {
    let threadListCalls = 0
    const manager = new CodexAppServerManager({
      client: {
        request: async <T>(method: string): Promise<T> => {
          if (method === 'thread/list') {
            threadListCalls += 1
            await new Promise((resolve) => setTimeout(resolve, 5))
            return {} as T
          }
          return {} as T
        },
        getRemoteUrl: () => null,
        stop: () => {},
      },
    })

    await Promise.all([manager.start(), manager.start(), manager.start(), manager.start()])

    expect(threadListCalls).toBe(1)
  })
})
