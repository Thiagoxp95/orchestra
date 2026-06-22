import { describe, expect, it, vi } from 'vitest'
import { cleanupEligibleWorktrees, isWorktreeCleanupEligible } from './worktree-cleanup'

describe('isWorktreeCleanupEligible', () => {
  it('never removes the main repo (index 0), even when its PR is merged', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 0, pr: { state: 'MERGED' } })).toBe(false)
  })

  it('is eligible when the PR is closed or merged', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 1, pr: { state: 'CLOSED' } })).toBe(true)
    expect(isWorktreeCleanupEligible({ treeIndex: 1, pr: { state: 'MERGED' } })).toBe(true)
    expect(isWorktreeCleanupEligible({ treeIndex: 1, pr: { state: 'merged' } })).toBe(true)
  })

  it('is not eligible for open or draft PRs', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 1, pr: { state: 'OPEN' } })).toBe(false)
    expect(isWorktreeCleanupEligible({ treeIndex: 1, pr: { state: 'DRAFT' } })).toBe(false)
  })

  it('is eligible when the Linear ticket is in staging or production (case-insensitive)', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: 'Staging' } } })).toBe(true)
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: 'production' } } })).toBe(true)
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: ' Production ' } } })).toBe(true)
  })

  it('matches done states by keyword, not exact name (e.g. "In production", "In staging")', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: 'In production' } } })).toBe(true)
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: 'In staging' } } })).toBe(true)
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: 'QA → Production' } } })).toBe(true)
  })

  it('is not eligible for other Linear states', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: 'In Progress' } } })).toBe(false)
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: 'First QA pass' } } })).toBe(false)
  })

  it('is eligible if either condition holds (PR merged even when Linear is not done)', () => {
    expect(isWorktreeCleanupEligible({
      treeIndex: 3,
      pr: { state: 'MERGED' },
      linearIssue: { state: { name: 'In Progress' } },
    })).toBe(true)
  })

  it('is not eligible with no PR and no Linear ticket', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 4 })).toBe(false)
  })
})

describe('cleanupEligibleWorktrees', () => {
  const makeTree = (treeIndex: number) => ({
    treeIndex,
    rootDir: `/wt/${treeIndex}`,
    sessionIds: [`s${treeIndex}a`, `s${treeIndex}b`],
  })

  it('removes every eligible tree from the store immediately, before any background command resolves', async () => {
    const removeFromStore = vi.fn()
    let commandResolved = false
    const runBackgroundCommand = vi.fn(async () => {
      // Simulate a slow destruction command.
      await new Promise((r) => setTimeout(r, 20))
      commandResolved = true
      return { success: true }
    })

    const promise = cleanupEligibleWorktrees([makeTree(1), makeTree(2)], {
      destructionActions: [{ name: 'teardown', command: 'echo hi' }],
      mainRoot: '/wt/0',
      killTerminal: vi.fn(),
      removeFromStore,
      runBackgroundCommand,
      removeWorktreeOnDisk: vi.fn(async () => ({ success: true })),
    })

    // Synchronous part has already run: both trees gone from the store, and
    // no background command has resolved yet.
    expect(removeFromStore).toHaveBeenCalledTimes(2)
    expect(commandResolved).toBe(false)

    await promise
  })

  it('removes trees from the store in descending index order so indices stay valid', async () => {
    const order: number[] = []
    const removeFromStore = vi.fn((treeIndex: number) => order.push(treeIndex))

    await cleanupEligibleWorktrees([makeTree(1), makeTree(3), makeTree(2)], {
      destructionActions: [],
      mainRoot: '/wt/0',
      killTerminal: vi.fn(),
      removeFromStore,
      runBackgroundCommand: vi.fn(async () => ({ success: true })),
      removeWorktreeOnDisk: vi.fn(async () => ({ success: true })),
    })

    expect(order).toEqual([3, 2, 1])
  })

  it('kills every session of every eligible tree', async () => {
    const killTerminal = vi.fn()

    await cleanupEligibleWorktrees([makeTree(1), makeTree(2)], {
      destructionActions: [],
      mainRoot: '/wt/0',
      killTerminal,
      removeFromStore: vi.fn(),
      runBackgroundCommand: vi.fn(async () => ({ success: true })),
      removeWorktreeOnDisk: vi.fn(async () => ({ success: true })),
    })

    expect(killTerminal.mock.calls.map((c) => c[0]).sort()).toEqual(['s1a', 's1b', 's2a', 's2b'])
  })

  it('runs destruction commands then on-disk removal in the background, against each snapshotted rootDir', async () => {
    const runBackgroundCommand = vi.fn(async () => ({ success: true }))
    const removeWorktreeOnDisk = vi.fn(async () => ({ success: true }))

    await cleanupEligibleWorktrees([makeTree(1), makeTree(2)], {
      destructionActions: [{ name: 'teardown', command: 'cmd' }],
      mainRoot: '/wt/0',
      killTerminal: vi.fn(),
      removeFromStore: vi.fn(),
      runBackgroundCommand,
      removeWorktreeOnDisk,
    })

    expect(runBackgroundCommand.mock.calls).toContainEqual(['/wt/1', 'cmd'])
    expect(runBackgroundCommand.mock.calls).toContainEqual(['/wt/2', 'cmd'])
    expect(removeWorktreeOnDisk.mock.calls).toContainEqual(['/wt/0', '/wt/1'])
    expect(removeWorktreeOnDisk.mock.calls).toContainEqual(['/wt/0', '/wt/2'])
  })

  it('reports a failed destruction command but still removes the worktree on disk', async () => {
    const onCommandFailed = vi.fn()
    const removeWorktreeOnDisk = vi.fn(async () => ({ success: true }))

    await cleanupEligibleWorktrees([makeTree(1)], {
      destructionActions: [{ name: 'teardown', command: 'cmd' }],
      mainRoot: '/wt/0',
      killTerminal: vi.fn(),
      removeFromStore: vi.fn(),
      runBackgroundCommand: vi.fn(async () => ({ success: false })),
      removeWorktreeOnDisk,
      onCommandFailed,
    })

    expect(onCommandFailed).toHaveBeenCalledWith('teardown')
    expect(removeWorktreeOnDisk).toHaveBeenCalledWith('/wt/0', '/wt/1')
  })

  it('a hanging command on one worktree never blocks removing any worktree from the store', async () => {
    const removeFromStore = vi.fn()
    // First worktree's command never resolves.
    const runBackgroundCommand = vi.fn(() => new Promise<{ success: boolean }>(() => {}))

    cleanupEligibleWorktrees([makeTree(1), makeTree(2)], {
      destructionActions: [{ command: 'hang' }],
      mainRoot: '/wt/0',
      killTerminal: vi.fn(),
      removeFromStore,
      runBackgroundCommand,
      removeWorktreeOnDisk: vi.fn(async () => ({ success: true })),
    })

    // No await — the synchronous UI teardown completes regardless of the hang.
    expect(removeFromStore).toHaveBeenCalledTimes(2)
  })
})
