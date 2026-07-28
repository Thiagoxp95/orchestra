import { describe, it, expect } from 'vitest'
import { reconcilePersistedWorktrees } from './reconcile-worktrees'
import type { PersistedData, Workspace } from '../shared/types'

function session(id: string): PersistedData['sessions'][string] {
  return {
    id,
    label: id,
    cwd: '/x',
    processStatus: 'terminal',
    workspaceId: 'w1',
    scrollback: '',
    env: {},
  } as unknown as PersistedData['sessions'][string]
}

function workspace(partial: Partial<Workspace>): Workspace {
  return {
    id: 'w1',
    name: 'WS',
    color: '#fff',
    trees: [],
    activeTreeIndex: 0,
    customActions: [],
    createdAt: 0,
    ...partial,
  }
}

function baseData(): PersistedData {
  return {
    workspaces: {
      w1: workspace({
        id: 'w1',
        activeTreeIndex: 2,
        lastActiveSessionId: 's-gone',
        trees: [
          { rootDir: '/repo', sessionIds: ['s-main'] }, // index 0 = main repo
          { rootDir: '/repo/.wt/alive', sessionIds: ['s-alive'] },
          { rootDir: '/repo/.wt/gone', sessionIds: ['s-gone'] }, // deleted on disk
        ],
      }),
    },
    sessions: {
      's-main': session('s-main'),
      's-alive': session('s-alive'),
      's-gone': session('s-gone'),
    },
    activeWorkspaceId: 'w1',
    activeSessionId: 's-gone',
    settings: { worktreesDir: '' } as PersistedData['settings'],
    claudeLastResponse: {},
    codexLastResponse: {},
  }
}

// Main repo (/repo) is present; only the '/gone' worktree is missing.
const exists = (p: string): boolean => !p.includes('/gone')

describe('reconcilePersistedWorktrees', () => {
  it('prunes a worktree whose directory is gone, plus its sessions', () => {
    const r = reconcilePersistedWorktrees(baseData(), exists)
    expect(r.removedTrees).toBe(1)
    expect(r.removedSessions).toBe(1)
    const trees = r.data.workspaces.w1.trees
    expect(trees.map((t) => t.rootDir)).toEqual(['/repo', '/repo/.wt/alive'])
    expect(Object.keys(r.data.sessions).sort()).toEqual(['s-alive', 's-main'])
  })

  it('repairs activeTreeIndex / activeSessionId / lastActiveSessionId', () => {
    const r = reconcilePersistedWorktrees(baseData(), exists)
    // The active tree (index 2) was removed → clamp to the main repo (0).
    expect(r.data.workspaces.w1.activeTreeIndex).toBe(0)
    expect(r.data.activeSessionId).toBeNull()
    expect(r.data.workspaces.w1.lastActiveSessionId).toBeNull()
  })

  it('keeps the active tree pointing at the same tree when an earlier tree is pruned', () => {
    const data = baseData()
    data.workspaces.w1.activeTreeIndex = 1
    const r = reconcilePersistedWorktrees(data, exists)
    expect(r.data.workspaces.w1.trees[r.data.workspaces.w1.activeTreeIndex].rootDir).toBe(
      '/repo/.wt/alive',
    )
  })

  it('never prunes the main repo (index 0)', () => {
    // Main present, all children missing → only children prune, repo stays.
    const r = reconcilePersistedWorktrees(baseData(), (p) => p === '/repo')
    expect(r.data.workspaces.w1.trees.map((t) => t.rootDir)).toEqual(['/repo'])
    expect(r.removedTrees).toBe(2)
  })

  it('SAFETY: prunes nothing when the main repo is missing (volume offline)', () => {
    // existsSync can return false for an unmounted disk; if the main repo itself
    // is gone we must not destroy the workspace's session/scrollback data.
    const r = reconcilePersistedWorktrees(baseData(), () => false)
    expect(r.removedTrees).toBe(0)
    expect(r.data.workspaces.w1.trees).toHaveLength(3)
    expect(Object.keys(r.data.sessions)).toHaveLength(3)
  })

  it('SAFETY: never drops a session still referenced by a kept tree', () => {
    const data = baseData()
    // The alive tree also references s-gone — pruning the gone tree must NOT
    // delete s-gone, because a kept tree still points at it.
    data.workspaces.w1.trees[1].sessionIds = ['s-alive', 's-gone']
    const r = reconcilePersistedWorktrees(data, exists)
    expect(r.removedTrees).toBe(1)
    expect(r.data.sessions['s-gone']).toBeDefined()
    expect(r.removedSessions).toBe(0)
  })

  it('SAFETY: tolerates a malformed / pre-migration store without throwing', () => {
    const bad = { activeWorkspaceId: null } as unknown as PersistedData
    const r = reconcilePersistedWorktrees(bad, () => true)
    expect(r.removedTrees).toBe(0)
    expect(r.data).toBe(bad)
  })

  it('returns the pruned trees and full session records for backup', () => {
    const r = reconcilePersistedWorktrees(baseData(), exists)
    expect(r.prunedTrees).toEqual([
      { workspaceId: 'w1', tree: { rootDir: '/repo/.wt/gone', sessionIds: ['s-gone'] } },
    ])
    expect(Object.keys(r.prunedSessions)).toEqual(['s-gone'])
    expect(r.prunedSessions['s-gone'].scrollback).toBe('')
  })

  it('is a no-op (returns the same reference) when every worktree still exists', () => {
    const data = baseData()
    const r = reconcilePersistedWorktrees(data, () => true)
    expect(r.removedTrees).toBe(0)
    expect(r.data).toBe(data)
  })
})
