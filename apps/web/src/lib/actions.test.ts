import { describe, expect, it } from 'bun:test'
import { selectActiveActions, SPIN_UP_AGENTS, buildCreateWorktreePayload, type SafeWorkspaceLike } from './actions'

const workspaces: SafeWorkspaceLike[] = [
  { id: 'w1', customActions: [{ id: 'a1', name: 'Deploy', icon: '__terminal__' }] },
  { id: 'w2', customActions: [{ id: 'a2', name: 'Claude', icon: '__claude__' }] },
  { id: 'w3' },
]

describe('selectActiveActions', () => {
  it('returns the active workspace actions', () => {
    expect(selectActiveActions(workspaces, 'w2')).toEqual([
      { id: 'a2', name: 'Claude', icon: '__claude__' },
    ])
  })
  it('returns [] when the workspace has no actions', () => {
    expect(selectActiveActions(workspaces, 'w3')).toEqual([])
  })
  it('returns [] when the active id is unknown or null', () => {
    expect(selectActiveActions(workspaces, 'nope')).toEqual([])
    expect(selectActiveActions(workspaces, null)).toEqual([])
  })
  it('returns [] when workspaces is undefined', () => {
    expect(selectActiveActions(undefined, 'w1')).toEqual([])
  })
})

describe('SPIN_UP_AGENTS', () => {
  it('lists the four agents matching the desktop dialog', () => {
    expect(SPIN_UP_AGENTS.map((a) => a.id)).toEqual(['terminal', 'claude', 'codex', 'cursor'])
  })
})

describe('buildCreateWorktreePayload', () => {
  it('trims the branch and passes through the rest', () => {
    expect(buildCreateWorktreePayload('w1', '  feature/x  ', ['a1'], 'claude')).toEqual({
      workspaceId: 'w1',
      branch: 'feature/x',
      selectedActionIds: ['a1'],
      spinUp: 'claude',
    })
  })

  it('accepts a null spinUp and empty actions', () => {
    expect(buildCreateWorktreePayload('w2', 'b', [], null)).toEqual({
      workspaceId: 'w2',
      branch: 'b',
      selectedActionIds: [],
      spinUp: null,
    })
  })
})
