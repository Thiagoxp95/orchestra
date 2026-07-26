import { describe, expect, test } from 'vitest'
import type { Workspace } from '../../../shared/types'
import {
  ALL_SCOPE,
  buildScopeGroups,
  flattenScopeGroups,
  fuzzyMatch,
  locateSession,
  matchesScope,
} from './resume-session-scopes'

function workspace(id: string, name: string, trees: { rootDir: string; displayName?: string }[]): Workspace {
  return {
    id,
    name,
    color: '#000000',
    trees: trees.map((t) => ({ ...t, sessionIds: [] })),
    activeTreeIndex: 0,
    customActions: [],
  } as unknown as Workspace
}

const workspaces: Record<string, Workspace> = {
  orch: workspace('orch', 'Orchestra', [
    { rootDir: '/Users/me/Tedy/orchestra' },
    { rootDir: '/Users/me/Tedy/worktrees/feature-x', displayName: 'feature-x' },
  ]),
  grow: workspace('grow', 'GoGrow', [{ rootDir: '/Users/me/Pessoal/GoGrow' }]),
}

describe('locateSession', () => {
  test('locates a session to the tree it ran in', () => {
    const scope = locateSession(workspaces, '/Users/me/Tedy/worktrees/feature-x', 'orch')
    expect(scope).toMatchObject({
      key: 'tree:orch:1',
      workspaceId: 'orch',
      treeIndex: 1,
      treeName: 'feature-x',
      text: 'Orchestra · feature-x',
    })
  })

  test('names the main checkout base', () => {
    expect(locateSession(workspaces, '/Users/me/Pessoal/GoGrow', 'orch').text).toBe('GoGrow · base')
  })

  test('folds a subdirectory into its tree, keeping the subpath visible', () => {
    const scope = locateSession(workspaces, '/Users/me/Tedy/orchestra/apps/web', 'orch')
    expect(scope.key).toBe('tree:orch:0')
    expect(scope.text).toBe('Orchestra · base · apps/web')
  })

  test('keeps an unknown directory selectable under its own path', () => {
    const scope = locateSession(workspaces, '/Users/me/scratch', 'orch')
    expect(scope).toMatchObject({ key: 'path:/Users/me/scratch', workspaceId: null, text: '~/scratch' })
  })
})

describe('buildScopeGroups', () => {
  const scopes = [
    locateSession(workspaces, '/Users/me/Tedy/orchestra', 'grow'),
    locateSession(workspaces, '/Users/me/Tedy/worktrees/feature-x', 'grow'),
    locateSession(workspaces, '/Users/me/Pessoal/GoGrow', 'grow'),
    locateSession(workspaces, '/Users/me/scratch', 'grow'),
  ]

  test('groups worktrees under their workspace, active workspace first', () => {
    const groups = buildScopeGroups(scopes, 'grow')
    expect(groups.map((g) => g.label)).toEqual(['GoGrow', 'Orchestra', 'Other folders'])
    // A single-tree workspace needs no "all trees" entry.
    expect(groups[0].options).toEqual([{ value: 'tree:grow:0', label: 'base' }])
    expect(groups[1].options).toEqual([
      { value: 'ws:orch', label: 'All trees' },
      { value: 'tree:orch:0', label: 'base' },
      { value: 'tree:orch:1', label: 'feature-x' },
    ])
    expect(groups[2].options).toEqual([{ value: 'path:/Users/me/scratch', label: '~/scratch' }])
  })

  test('flattens to every selectable value', () => {
    expect(flattenScopeGroups(buildScopeGroups(scopes, 'grow')).map((o) => o.value)).toContain('tree:orch:1')
  })

  test('a workspace with no sessions never appears', () => {
    const groups = buildScopeGroups([locateSession(workspaces, '/Users/me/Pessoal/GoGrow', null)], null)
    expect(groups.map((g) => g.label)).toEqual(['GoGrow'])
  })
})

describe('matchesScope', () => {
  const base = locateSession(workspaces, '/Users/me/Tedy/orchestra', 'orch')
  const worktree = locateSession(workspaces, '/Users/me/Tedy/worktrees/feature-x', 'orch')
  const loose = locateSession(workspaces, '/Users/me/scratch', 'orch')

  test('the all scope takes everything', () => {
    for (const scope of [base, worktree, loose]) expect(matchesScope(ALL_SCOPE, scope)).toBe(true)
  })

  test('a workspace scope takes every one of its trees', () => {
    expect(matchesScope('ws:orch', base)).toBe(true)
    expect(matchesScope('ws:orch', worktree)).toBe(true)
    expect(matchesScope('ws:orch', loose)).toBe(false)
  })

  test('a tree scope takes only that tree', () => {
    expect(matchesScope('tree:orch:1', worktree)).toBe(true)
    expect(matchesScope('tree:orch:1', base)).toBe(false)
  })

  test('a path scope takes only that directory', () => {
    expect(matchesScope('path:/Users/me/scratch', loose)).toBe(true)
    expect(matchesScope('path:/Users/me/other', loose)).toBe(false)
  })
})

describe('fuzzyMatch', () => {
  test('matches characters in order, not necessarily adjacent', () => {
    expect(fuzzyMatch('orch', 'Orchestra · base')).toBe(true)
    expect(fuzzyMatch('obse', 'Orchestra · base')).toBe(true)
    expect(fuzzyMatch('zz', 'Orchestra · base')).toBe(false)
  })

  test('every word must match, in any order', () => {
    expect(fuzzyMatch('web orch', 'Orchestra · base · apps/web')).toBe(true)
    expect(fuzzyMatch('web gogrow', 'Orchestra · base · apps/web')).toBe(false)
  })

  test('is case-insensitive and takes an empty query', () => {
    expect(fuzzyMatch('ORCH', 'orchestra')).toBe(true)
    expect(fuzzyMatch('   ', 'anything')).toBe(true)
  })
})
