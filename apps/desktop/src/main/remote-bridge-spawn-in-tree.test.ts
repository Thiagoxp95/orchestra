import { describe, expect, it } from 'vitest'
import { normalizeSpawnInTreePayload } from './remote-bridge-spawn-in-tree'

describe('normalizeSpawnInTreePayload', () => {
  it('normalizes an agent spawn', () => {
    expect(normalizeSpawnInTreePayload({ workspaceId: 'w1', treeIndex: 2, agent: 'claude' })).toEqual({
      workspaceId: 'w1',
      treeIndex: 2,
      agent: 'claude',
      actionId: null,
    })
  })

  it('normalizes an action run', () => {
    expect(normalizeSpawnInTreePayload({ workspaceId: 'w1', treeIndex: 0, actionId: 'a1' })).toEqual({
      workspaceId: 'w1',
      treeIndex: 0,
      agent: null,
      actionId: 'a1',
    })
  })

  it('nulls an invalid agent and defaults a bad treeIndex to 0', () => {
    expect(normalizeSpawnInTreePayload({ agent: 'bogus', treeIndex: -3 })).toEqual({
      workspaceId: '',
      treeIndex: 0,
      agent: null,
      actionId: null,
    })
    expect(normalizeSpawnInTreePayload({ treeIndex: 'x' }).treeIndex).toBe(0)
  })

  it('handles a null/undefined payload', () => {
    expect(normalizeSpawnInTreePayload(undefined)).toEqual({
      workspaceId: '',
      treeIndex: 0,
      agent: null,
      actionId: null,
    })
  })
})
