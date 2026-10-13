import { describe, expect, it } from 'vitest'
import { normalizeSpawnInTreePayload } from './remote-bridge-spawn-in-tree'

describe('normalizeSpawnInTreePayload', () => {
  it('normalizes an agent spawn', () => {
    expect(normalizeSpawnInTreePayload({ workspaceId: 'w1', treeIndex: 2, agent: 'claude' })).toEqual({
      workspaceId: 'w1',
      treeIndex: 2,
      agent: 'claude',
      actionId: null,
      origin: 'user',
    })
  })

  it('normalizes an action run', () => {
    expect(normalizeSpawnInTreePayload({ workspaceId: 'w1', treeIndex: 0, actionId: 'a1' })).toEqual({
      workspaceId: 'w1',
      treeIndex: 0,
      agent: null,
      actionId: 'a1',
      origin: 'user',
    })
  })

  it('nulls an invalid agent and defaults a bad treeIndex to 0', () => {
    expect(normalizeSpawnInTreePayload({ agent: 'bogus', treeIndex: -3 })).toEqual({
      workspaceId: '',
      treeIndex: 0,
      agent: null,
      actionId: null,
      origin: 'user',
    })
    expect(normalizeSpawnInTreePayload({ treeIndex: 'x' }).treeIndex).toBe(0)
  })

  it('keeps origin mcp and treats anything else as the user', () => {
    expect(normalizeSpawnInTreePayload({ agent: 'claude', origin: 'mcp' }).origin).toBe('mcp')
    expect(normalizeSpawnInTreePayload({ agent: 'claude', origin: 'robot' }).origin).toBe('user')
  })

  it('handles a null/undefined payload', () => {
    expect(normalizeSpawnInTreePayload(undefined)).toEqual({
      workspaceId: '',
      treeIndex: 0,
      agent: null,
      actionId: null,
      origin: 'user',
    })
  })
})
