import { describe, expect, it } from 'vitest'
import {
  ALL_SCOPE,
  buildScopeGroups,
  filterSessions,
  findTreeForCwd,
  flattenScopeGroups,
  fuzzyMatch,
  locateSession,
  locateSessions,
  matchesScope,
  resumeWorkspaceId,
  type RemoteAgentSession,
  type ResumeWorkspaceLike,
} from './resume-sessions'

const workspaces: ResumeWorkspaceLike[] = [
  {
    id: 'orch',
    name: 'Orchestra',
    trees: [
      { rootDir: '/Users/me/Tedy/orchestra', branch: 'main' },
      { rootDir: '/Users/me/Tedy/worktrees/feature-x', branch: 'feature-x' },
    ],
  },
  { id: 'grow', name: 'GoGrow', trees: [{ rootDir: '/Users/me/Pessoal/GoGrow' }] },
]

function session(overrides: Partial<RemoteAgentSession> = {}): RemoteAgentSession {
  return {
    agent: 'claude',
    sessionId: 'sess-1',
    cwd: '/Users/me/Tedy/orchestra',
    cwdExists: true,
    gitBranch: 'main',
    updatedAt: 1000,
    title: 'Ship the resume sheet',
    summary: 'shipped',
    summaryIsUser: false,
    ...overrides,
  }
}

describe('findTreeForCwd', () => {
  it('matches the tree that owns the directory', () => {
    expect(findTreeForCwd(workspaces, '/Users/me/Tedy/worktrees/feature-x')).toEqual({
      workspaceId: 'orch',
      treeIndex: 1,
      exact: true,
    })
  })

  it('falls back to the deepest containing tree', () => {
    expect(findTreeForCwd(workspaces, '/Users/me/Tedy/orchestra/apps/web')).toEqual({
      workspaceId: 'orch',
      treeIndex: 0,
      exact: false,
    })
  })

  it('returns null for an unknown directory or missing mirror', () => {
    expect(findTreeForCwd(workspaces, '/Users/me/scratch')).toBeNull()
    expect(findTreeForCwd(undefined, '/Users/me/Tedy/orchestra')).toBeNull()
  })
})

describe('locateSession', () => {
  it('labels a worktree by its branch', () => {
    expect(locateSession(workspaces, '/Users/me/Tedy/worktrees/feature-x').text).toBe(
      'Orchestra · feature-x',
    )
  })

  it('labels a branchless main checkout base', () => {
    expect(locateSession(workspaces, '/Users/me/Pessoal/GoGrow').text).toBe('GoGrow · base')
  })

  it('keeps the subdirectory visible but groups under the tree', () => {
    const scope = locateSession(workspaces, '/Users/me/Tedy/orchestra/apps/web')
    expect(scope.key).toBe('tree:orch:0')
    expect(scope.text).toBe('Orchestra · main · apps/web')
  })

  it('keeps an unknown directory selectable under its own path', () => {
    expect(locateSession(workspaces, '/Users/me/scratch')).toMatchObject({
      key: 'path:/Users/me/scratch',
      workspaceId: null,
      text: '~/scratch',
    })
  })
})

describe('buildScopeGroups', () => {
  const scopes = [
    '/Users/me/Tedy/orchestra',
    '/Users/me/Tedy/worktrees/feature-x',
    '/Users/me/Pessoal/GoGrow',
    '/Users/me/scratch',
  ].map((cwd) => locateSession(workspaces, cwd))

  it('groups worktrees under their workspace, active first', () => {
    const groups = buildScopeGroups(scopes, 'grow')
    expect(groups.map((g) => g.label)).toEqual(['GoGrow', 'Orchestra', 'Other folders'])
    expect(groups[0].options).toEqual([{ value: 'tree:grow:0', label: 'base' }])
    expect(groups[1].options).toEqual([
      { value: 'ws:orch', label: 'All trees' },
      { value: 'tree:orch:0', label: 'main' },
      { value: 'tree:orch:1', label: 'feature-x' },
    ])
  })

  it('flattens to every selectable value', () => {
    const values = flattenScopeGroups(buildScopeGroups(scopes, null)).map((o) => o.value)
    expect(values).toContain('tree:orch:1')
    expect(values).toContain('path:/Users/me/scratch')
  })
})

describe('matchesScope', () => {
  const base = locateSession(workspaces, '/Users/me/Tedy/orchestra')
  const worktree = locateSession(workspaces, '/Users/me/Tedy/worktrees/feature-x')

  it('takes everything under the all scope', () => {
    expect(matchesScope(ALL_SCOPE, base)).toBe(true)
  })

  it('takes every tree of a workspace scope', () => {
    expect(matchesScope('ws:orch', base)).toBe(true)
    expect(matchesScope('ws:orch', worktree)).toBe(true)
  })

  it('takes only the picked tree', () => {
    expect(matchesScope('tree:orch:1', worktree)).toBe(true)
    expect(matchesScope('tree:orch:1', base)).toBe(false)
  })
})

describe('fuzzyMatch', () => {
  it('matches characters in order', () => {
    expect(fuzzyMatch('orch', 'Orchestra · main')).toBe(true)
    expect(fuzzyMatch('zz', 'Orchestra · main')).toBe(false)
  })

  it('requires every word, in any order', () => {
    expect(fuzzyMatch('web orch', 'Orchestra · main · apps/web')).toBe(true)
    expect(fuzzyMatch('web gogrow', 'Orchestra · main · apps/web')).toBe(false)
  })

  it('takes an empty query', () => {
    expect(fuzzyMatch('  ', 'anything')).toBe(true)
  })
})

describe('filterSessions', () => {
  const located = locateSessions(
    [
      session({ sessionId: 'a', title: 'resume sheet', cwd: '/Users/me/Tedy/orchestra' }),
      session({
        sessionId: 'b',
        agent: 'codex',
        title: 'fix the mirror',
        cwd: '/Users/me/Tedy/worktrees/feature-x',
      }),
      session({ sessionId: 'c', title: 'seed the garden', cwd: '/Users/me/Pessoal/GoGrow' }),
    ],
    workspaces,
  )

  const ids = (list: ReturnType<typeof filterSessions>) => list.map((l) => l.session.sessionId)

  it('narrows by agent', () => {
    expect(ids(filterSessions(located, { agent: 'codex', scope: ALL_SCOPE, query: '' }))).toEqual(['b'])
  })

  it('narrows by workspace, across its worktrees', () => {
    expect(ids(filterSessions(located, { agent: 'all', scope: 'ws:orch', query: '' }))).toEqual(['a', 'b'])
  })

  it('narrows by a single worktree', () => {
    expect(ids(filterSessions(located, { agent: 'all', scope: 'tree:orch:1', query: '' }))).toEqual(['b'])
  })

  it('searches titles and the workspace text together', () => {
    expect(ids(filterSessions(located, { agent: 'all', scope: ALL_SCOPE, query: 'garden' }))).toEqual(['c'])
    expect(ids(filterSessions(located, { agent: 'all', scope: ALL_SCOPE, query: 'gogrow' }))).toEqual(['c'])
  })

  it('combines every filter', () => {
    expect(
      ids(filterSessions(located, { agent: 'claude', scope: 'ws:orch', query: 'resume' })),
    ).toEqual(['a'])
  })
})

describe('resumeWorkspaceId', () => {
  it('uses the tree owner when there is one', () => {
    expect(resumeWorkspaceId(locateSession(workspaces, '/Users/me/Tedy/orchestra'), 'grow')).toBe('orch')
  })

  it('falls back to the desktop active workspace, like the desktop plan does', () => {
    expect(resumeWorkspaceId(locateSession(workspaces, '/Users/me/scratch'), 'grow')).toBe('grow')
    expect(resumeWorkspaceId(locateSession(workspaces, '/Users/me/scratch'), null)).toBeNull()
  })
})
