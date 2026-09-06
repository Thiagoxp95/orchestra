import { describe, expect, it, test } from 'vitest'
import type { RecentAgentSession, Workspace } from '../../../shared/types'
import { canResumeSession, findTreeForCwd, planResume } from './resume-agent-session'

function workspace(id: string, rootDirs: string[], activeTreeIndex = 0): Workspace {
  return {
    id,
    name: id,
    color: '#000000',
    trees: rootDirs.map((rootDir) => ({ rootDir, sessionIds: [] })),
    activeTreeIndex,
    customActions: [],
  } as unknown as Workspace
}

function session(overrides: Partial<RecentAgentSession> = {}): RecentAgentSession {
  return {
    agent: 'claude',
    sessionId: 'sess-1',
    filePath: '/transcripts/sess-1.jsonl',
    cwd: '/repo',
    cwdExists: true,
    gitBranch: null,
    updatedAt: 0,
    title: null,
    lastUserMessage: null,
    lastAssistantMessage: null,
    ...overrides,
  }
}

describe('findTreeForCwd', () => {
  const workspaces = {
    a: workspace('a', ['/repo', '/repo/worktrees/one']),
    b: workspace('b', ['/other', '/repo']),
  }

  test('matches the tree that owns the directory', () => {
    expect(findTreeForCwd(workspaces, '/repo/worktrees/one', 'a')).toEqual({
      workspaceId: 'a', treeIndex: 1, exact: true,
    })
  })

  test('ignores a trailing slash', () => {
    expect(findTreeForCwd(workspaces, '/other/', 'a')).toEqual({
      workspaceId: 'b', treeIndex: 0, exact: true,
    })
  })

  test('prefers the active workspace when several share a directory', () => {
    expect(findTreeForCwd(workspaces, '/repo', 'b')).toEqual({ workspaceId: 'b', treeIndex: 1, exact: true })
    expect(findTreeForCwd(workspaces, '/repo', 'a')).toEqual({ workspaceId: 'a', treeIndex: 0, exact: true })
  })

  test('falls back to the deepest tree containing the directory', () => {
    expect(findTreeForCwd(workspaces, '/repo/apps/web', 'a')).toEqual({
      workspaceId: 'a', treeIndex: 0, exact: false,
    })
    // The worktree is itself under /repo, so its own subdirectories are its own.
    expect(findTreeForCwd(workspaces, '/repo/worktrees/one/apps/web', 'a')).toEqual({
      workspaceId: 'a', treeIndex: 1, exact: false,
    })
  })

  test('an exact owner beats a tree that merely contains the directory', () => {
    const nested = { a: workspace('a', ['/repo']), b: workspace('b', ['/repo/apps/web']) }
    expect(findTreeForCwd(nested, '/repo/apps/web', 'a')).toEqual({
      workspaceId: 'b', treeIndex: 0, exact: true,
    })
  })

  test('returns null when no tree matches', () => {
    expect(findTreeForCwd(workspaces, '/elsewhere', 'a')).toBeNull()
    expect(findTreeForCwd(workspaces, '', 'a')).toBeNull()
  })
})

describe('planResume', () => {
  const workspaces = { a: workspace('a', ['/repo', '/repo/worktrees/one'], 1) }

  test('spawns in the owning tree with no cwd override', () => {
    const plan = planResume(session({ cwd: '/repo/worktrees/one' }), workspaces, 'a')
    expect(plan).toEqual({
      workspaceId: 'a',
      treeIndex: 1,
      command: 'claude --resume sess-1 --model opus --effort high --dangerously-skip-permissions',
      cwdOverride: undefined,
    })
  })

  test('spawns in the containing tree, still in the session directory', () => {
    const plan = planResume(session({ cwd: '/repo/apps/web' }), workspaces, 'a')
    expect(plan).toMatchObject({ workspaceId: 'a', treeIndex: 0, cwdOverride: '/repo/apps/web' })
  })

  test('falls back to the active tree but keeps the session directory', () => {
    const plan = planResume(session({ agent: 'codex', sessionId: 'codex-9', cwd: '/somewhere/else' }), workspaces, 'a')
    expect(plan?.workspaceId).toBe('a')
    expect(plan?.treeIndex).toBe(1)
    expect(plan?.cwdOverride).toBe('/somewhere/else')
    expect(plan?.command).toContain('codex resume codex-9')
    expect(plan?.command).toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  test('gives up when there is no workspace to spawn into', () => {
    expect(planResume(session({ cwd: '/somewhere/else' }), workspaces, null)).toBeNull()
    expect(planResume(session({ cwd: '/somewhere/else' }), {}, 'missing')).toBeNull()
  })
})

describe('canResumeSession', () => {
  const base = { id: 's1', processStatus: 'claude' as const, resumeSessionId: 'abc', resumeAgent: 'claude' as const }

  it('offers a resume for a pane with a conversation and a dead PTY', () => {
    expect(canResumeSession(base, { s1: true })).toBe(true)
  })

  // The dangerous case: pressing resume on a live pane would kill working agent.
  it('never offers a resume while the pane still has a PTY', () => {
    expect(canResumeSession(base, {})).toBe(false)
    expect(canResumeSession(base, { s1: false })).toBe(false)
  })

  it('offers nothing for a pane whose conversation was never resolved', () => {
    expect(canResumeSession({ ...base, resumeSessionId: undefined }, { s1: true })).toBe(false)
  })

  // A row recorded before resumeAgent existed falls back to what it is running.
  it('falls back to the process status when the agent was not recorded', () => {
    expect(canResumeSession({ ...base, resumeAgent: undefined }, { s1: true })).toBe(true)
    expect(
      canResumeSession({ ...base, resumeAgent: undefined, processStatus: 'terminal' }, { s1: true }),
    ).toBe(false)
  })

  it('covers cursor, not just claude and codex', () => {
    expect(
      canResumeSession({ ...base, resumeAgent: 'cursor', processStatus: 'cursor' }, { s1: true }),
    ).toBe(true)
  })
})
