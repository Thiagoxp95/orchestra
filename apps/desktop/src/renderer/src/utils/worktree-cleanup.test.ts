import { describe, expect, it, vi } from 'vitest'
import {
  destroyWorktrees,
  forgetDestroyedWorktree,
  isWorktreeCleanupEligible,
  isWorktreeDestroyed,
  pruneTreeCache,
} from './worktree-cleanup'

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

describe('destroyWorktrees', () => {
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

    const promise = destroyWorktrees([makeTree(1), makeTree(2)], {
      destructionActions: [{ name: 'teardown', command: 'echo hi' }],
      mainRoot: '/wt/0',
      killTerminal: vi.fn(),
      backupWorktree: vi.fn(async () => ({ backupId: 'b' })),
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

    await destroyWorktrees([makeTree(1), makeTree(3), makeTree(2)], {
      destructionActions: [],
      mainRoot: '/wt/0',
      killTerminal: vi.fn(),
      backupWorktree: vi.fn(async () => ({ backupId: 'b' })),
      removeFromStore,
      runBackgroundCommand: vi.fn(async () => ({ success: true })),
      removeWorktreeOnDisk: vi.fn(async () => ({ success: true })),
    })

    expect(order).toEqual([3, 2, 1])
  })

  it('kills every session of every eligible tree', async () => {
    const killTerminal = vi.fn()

    await destroyWorktrees([makeTree(1), makeTree(2)], {
      destructionActions: [],
      mainRoot: '/wt/0',
      killTerminal,
      backupWorktree: vi.fn(async () => ({ backupId: 'b' })),
      removeFromStore: vi.fn(),
      runBackgroundCommand: vi.fn(async () => ({ success: true })),
      removeWorktreeOnDisk: vi.fn(async () => ({ success: true })),
    })

    expect(killTerminal.mock.calls.map((c) => c[0]).sort()).toEqual(['s1a', 's1b', 's2a', 's2b'])
  })

  it('runs destruction commands then on-disk removal in the background, against each snapshotted rootDir', async () => {
    const runBackgroundCommand = vi.fn(async () => ({ success: true }))
    const removeWorktreeOnDisk = vi.fn(async () => ({ success: true }))

    await destroyWorktrees([makeTree(1), makeTree(2)], {
      destructionActions: [{ name: 'teardown', command: 'cmd' }],
      mainRoot: '/wt/0',
      killTerminal: vi.fn(),
      backupWorktree: vi.fn(async () => ({ backupId: 'b' })),
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

    await destroyWorktrees([makeTree(1)], {
      destructionActions: [{ name: 'teardown', command: 'cmd' }],
      mainRoot: '/wt/0',
      killTerminal: vi.fn(),
      backupWorktree: vi.fn(async () => ({ backupId: 'b' })),
      removeFromStore: vi.fn(),
      runBackgroundCommand: vi.fn(async () => ({ success: false })),
      removeWorktreeOnDisk,
      onCommandFailed,
    })

    expect(onCommandFailed).toHaveBeenCalledWith('teardown')
    expect(removeWorktreeOnDisk).toHaveBeenCalledWith('/wt/0', '/wt/1')
  })

  it('fires the backup before the tree leaves the store, so the session records are still persisted', async () => {
    const order: string[] = []

    destroyWorktrees([makeTree(1)], {
      destructionActions: [],
      mainRoot: '/wt/0',
      killTerminal: vi.fn(),
      removeFromStore: vi.fn(() => order.push('removeFromStore')),
      backupWorktree: vi.fn(async () => {
        order.push('backup')
        return { backupId: 'b' }
      }),
      runBackgroundCommand: vi.fn(async () => ({ success: true })),
      removeWorktreeOnDisk: vi.fn(async () => ({ success: true })),
    })

    expect(order).toEqual(['backup', 'removeFromStore'])
  })

  it('waits for the backup before running destruction scripts or deleting the directory', async () => {
    const order: string[] = []
    let releaseBackup = (): void => {}
    const backupWorktree = vi.fn(
      () =>
        new Promise<{ backupId: string }>((resolve) => {
          releaseBackup = () => resolve({ backupId: 'b' })
        }),
    )

    const promise = destroyWorktrees([makeTree(1)], {
      destructionActions: [{ name: 'teardown', command: 'cmd' }],
      mainRoot: '/wt/0',
      killTerminal: vi.fn(),
      removeFromStore: vi.fn(),
      backupWorktree,
      runBackgroundCommand: vi.fn(async () => {
        order.push('destruction')
        return { success: true }
      }),
      removeWorktreeOnDisk: vi.fn(async () => {
        order.push('rm')
        return { success: true }
      }),
    })

    await Promise.resolve()
    expect(order).toEqual([]) // still blocked on the backup

    releaseBackup()
    await promise
    expect(order).toEqual(['destruction', 'rm'])
  })

  it('still tears the tree down when the backup rejects', async () => {
    const removeWorktreeOnDisk = vi.fn(async () => ({ success: true }))
    const removeFromStore = vi.fn()

    await destroyWorktrees([makeTree(1)], {
      destructionActions: [],
      mainRoot: '/wt/0',
      killTerminal: vi.fn(),
      removeFromStore,
      backupWorktree: vi.fn(async () => {
        throw new Error('backup exploded')
      }),
      runBackgroundCommand: vi.fn(async () => ({ success: true })),
      removeWorktreeOnDisk,
    })

    expect(removeFromStore).toHaveBeenCalledTimes(1)
    expect(removeWorktreeOnDisk).toHaveBeenCalledWith('/wt/0', '/wt/1')
  })

  it('a hanging command on one worktree never blocks removing any worktree from the store', async () => {
    const removeFromStore = vi.fn()
    // First worktree's command never resolves.
    const runBackgroundCommand = vi.fn(() => new Promise<{ success: boolean }>(() => {}))

    destroyWorktrees([makeTree(1), makeTree(2)], {
      destructionActions: [{ command: 'hang' }],
      mainRoot: '/wt/0',
      killTerminal: vi.fn(),
      backupWorktree: vi.fn(async () => ({ backupId: 'b' })),
      removeFromStore,
      runBackgroundCommand,
      removeWorktreeOnDisk: vi.fn(async () => ({ success: true })),
    })

    // No await — the synchronous UI teardown completes regardless of the hang.
    expect(removeFromStore).toHaveBeenCalledTimes(2)
  })
})

describe('destroyed-worktree tombstones', () => {
  const deps = () => ({
    destructionActions: [],
    mainRoot: '/wt/0',
    killTerminal: vi.fn(),
    backupWorktree: vi.fn(async () => ({ backupId: 'b' })),
    removeFromStore: vi.fn(),
    runBackgroundCommand: vi.fn(async () => ({ success: true })),
    removeWorktreeOnDisk: vi.fn(async () => ({ success: true })),
  })

  it('marks a tree destroyed synchronously, before any disk work finishes', () => {
    destroyWorktrees([{ treeIndex: 1, rootDir: '/wt/tomb-a', sessionIds: [] }], deps())
    // No await: the on-disk directory still exists here, which is exactly when
    // the sidebar's auto-discovery used to re-add it.
    expect(isWorktreeDestroyed('/wt/tomb-a')).toBe(true)
    forgetDestroyedWorktree('/wt/tomb-a')
  })

  it('stays marked after the on-disk removal fails, so a failed delete cannot resurrect the tree', async () => {
    const d = deps()
    d.removeWorktreeOnDisk = vi.fn(async () => ({ success: false }))
    await destroyWorktrees([{ treeIndex: 1, rootDir: '/wt/tomb-b', sessionIds: [] }], d)
    expect(isWorktreeDestroyed('/wt/tomb-b')).toBe(true)
    forgetDestroyedWorktree('/wt/tomb-b')
  })

  it('forgetting a path allows tracking it again (re-created or restored worktree)', () => {
    destroyWorktrees([{ treeIndex: 1, rootDir: '/wt/tomb-c', sessionIds: [] }], deps())
    forgetDestroyedWorktree('/wt/tomb-c')
    expect(isWorktreeDestroyed('/wt/tomb-c')).toBe(false)
  })
})

describe('pruneTreeCache', () => {
  const live = {
    ws1: { trees: [{ rootDir: '/main' }, { rootDir: '/wt/b' }] },
  }

  it('drops entries whose tree is gone, keeping the survivors on their own key', () => {
    // /wt/a was deleted; with index keys its PR used to land on /wt/b's row.
    const prev = { ws1: { '/main': 1, '/wt/a': 2, '/wt/b': 3 } }
    expect(pruneTreeCache(prev, live)).toEqual({ ws1: { '/main': 1, '/wt/b': 3 } })
  })

  it('drops whole workspaces that no longer exist', () => {
    expect(pruneTreeCache({ gone: { '/x': 1 } }, live)).toEqual({})
  })

  it('applies updates on top of the prune', () => {
    const prev = { ws1: { '/wt/a': 1 } }
    expect(pruneTreeCache(prev, live, [{ wsId: 'ws1', rootDir: '/wt/b', value: 9 }]))
      .toEqual({ ws1: { '/wt/b': 9 } })
  })

  it('returns the same reference when nothing changes, so pollers do not re-render', () => {
    const prev = { ws1: { '/main': 1, '/wt/b': 3 } }
    expect(pruneTreeCache(prev, live, [{ wsId: 'ws1', rootDir: '/main', value: 1 }])).toBe(prev)
  })
})
