import { describe, expect, it } from 'vitest'
import { normalizeCreateWorktreePayload } from './remote-bridge-create-worktree'

describe('normalizeCreateWorktreePayload', () => {
  it('coerces fields and preserves a valid spinUp', () => {
    expect(
      normalizeCreateWorktreePayload({
        workspaceId: 'w1',
        branch: 'feature/x',
        selectedActionIds: ['a1', 'a2'],
        spinUp: 'claude',
      }),
    ).toEqual({
      workspaceId: 'w1',
      branch: 'feature/x',
      selectedActionIds: ['a1', 'a2'],
      spinUp: 'claude',
    })
  })

  it('defaults missing fields and nulls an invalid spinUp', () => {
    expect(normalizeCreateWorktreePayload({ spinUp: 'bogus' })).toEqual({
      workspaceId: '',
      branch: '',
      selectedActionIds: [],
      spinUp: null,
    })
  })

  it('forces selectedActionIds to a string array when not an array', () => {
    expect(normalizeCreateWorktreePayload({ selectedActionIds: 'nope' }).selectedActionIds).toEqual([])
    expect(normalizeCreateWorktreePayload({ selectedActionIds: [1, 2] }).selectedActionIds).toEqual(['1', '2'])
  })

  it('handles a null/undefined payload', () => {
    expect(normalizeCreateWorktreePayload(undefined)).toEqual({
      workspaceId: '',
      branch: '',
      selectedActionIds: [],
      spinUp: null,
    })
  })
})
