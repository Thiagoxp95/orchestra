import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import {
  enqueuePendingDeletion,
  loadPendingDeletions,
  dropPendingDeletion,
  removeWorktreeFromDisk,
  retryPendingDeletions,
  type RemovalDeps,
} from './worktree-removal'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'wt-removal-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

/** Deps where nothing exists, nothing succeeds, and delays are free. */
function deps(overrides: Partial<RemovalDeps> = {}): RemovalDeps {
  return {
    runGit: vi.fn(async () => ({ ok: true })),
    rmrf: vi.fn(async () => ({ ok: true })),
    shellRmrf: vi.fn(async () => ({ ok: true })),
    exists: vi.fn(() => false),
    delay: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('removeWorktreeFromDisk', () => {
  it('prunes and returns success when the directory is already gone', async () => {
    const runGit = vi.fn(async () => ({ ok: true }))
    const result = await removeWorktreeFromDisk('/repo', '/wt/gone', deps({ runGit, exists: () => false }))

    expect(result).toEqual({ success: true, attempts: 1 })
    expect(runGit).toHaveBeenCalledWith('/repo', ['worktree', 'prune'])
  })

  it('succeeds on the first attempt when git removes the worktree', async () => {
    const runGit = vi.fn(async () => ({ ok: true }))
    const rmrf = vi.fn(async () => ({ ok: true }))

    const result = await removeWorktreeFromDisk('/repo', '/wt/1', deps({ runGit, rmrf, exists: () => true }))

    expect(result.success).toBe(true)
    expect(runGit).toHaveBeenCalledWith('/repo', ['worktree', 'remove', '--force', '/wt/1'])
    expect(rmrf).not.toHaveBeenCalled() // no need for the fallbacks
  })

  it('falls back to fs.rm when git refuses, and reports success once the dir is gone', async () => {
    let gone = false
    const runGit = vi.fn(async (_cwd: string, args: string[]) =>
      args[1] === 'remove' ? { ok: false, error: 'EMFILE' } : { ok: true },
    )
    const rmrf = vi.fn(async () => {
      gone = true
      return { ok: true }
    })
    const shellRmrf = vi.fn(async () => ({ ok: true }))

    const result = await removeWorktreeFromDisk(
      '/repo',
      '/wt/1',
      deps({ runGit, rmrf, shellRmrf, exists: () => !gone }),
    )

    expect(result).toEqual({ success: true, attempts: 1 })
    expect(shellRmrf).not.toHaveBeenCalled()
  })

  it('retries with backoff and succeeds once a transient EMFILE clears', async () => {
    let attempt = 0
    const runGit = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[1] !== 'remove') return { ok: true }
      attempt++
      return attempt < 3 ? { ok: false, error: 'Too many open files in system' } : { ok: true }
    })
    const delay = vi.fn(async () => {})

    const result = await removeWorktreeFromDisk(
      '/repo',
      '/wt/1',
      deps({
        runGit,
        delay,
        exists: () => true,
        rmrf: async () => ({ ok: false, error: 'EMFILE' }),
        shellRmrf: async () => ({ ok: false, error: 'EMFILE' }),
      }),
    )

    expect(result).toEqual({ success: true, attempts: 3 })
    expect(delay).toHaveBeenCalledTimes(2)
  })

  it('gives up with the last error after every attempt is spent', async () => {
    const result = await removeWorktreeFromDisk(
      '/repo',
      '/wt/1',
      deps({
        exists: () => true,
        runGit: async (_cwd, args) => (args[1] === 'remove' ? { ok: false, error: 'still busy' } : { ok: true }),
        rmrf: async () => ({ ok: false, error: 'still busy' }),
        shellRmrf: async () => ({ ok: false, error: 'still busy' }),
      }),
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('still busy')
  })
})

describe('pending deletion queue', () => {
  it('records, dedupes by worktree, and drops entries', () => {
    enqueuePendingDeletion({ mainRepoDir: '/repo', worktreeDir: '/wt/1', lastError: 'boom' }, home, 100)
    enqueuePendingDeletion({ mainRepoDir: '/repo', worktreeDir: '/wt/1', lastError: 'boom again' }, home, 200)
    enqueuePendingDeletion({ mainRepoDir: '/repo', worktreeDir: '/wt/2' }, home, 300)

    const entries = loadPendingDeletions(home)
    expect(entries.map((e) => e.worktreeDir)).toEqual(['/wt/1', '/wt/2'])
    expect(entries[0]).toMatchObject({ queuedAt: 200, attempts: 0, lastError: 'boom again' })

    dropPendingDeletion('/wt/1', home)
    expect(loadPendingDeletions(home).map((e) => e.worktreeDir)).toEqual(['/wt/2'])
  })

  it('returns an empty queue when the file is missing or corrupt', () => {
    expect(loadPendingDeletions(home)).toEqual([])
    fs.writeFileSync(join(home, 'pending-deletions.json'), 'not json')
    expect(loadPendingDeletions(home)).toEqual([])
  })

  it('clears entries whose directory finally vanished', async () => {
    enqueuePendingDeletion({ mainRepoDir: '/repo', worktreeDir: '/wt/1' }, home)

    const result = await retryPendingDeletions(home, deps({ exists: () => false }))

    expect(result).toEqual({ removed: 1, remaining: 0 })
    expect(loadPendingDeletions(home)).toEqual([])
  })

  it('keeps an entry (with an incremented attempt count) when the retry fails again', async () => {
    enqueuePendingDeletion({ mainRepoDir: '/repo', worktreeDir: '/wt/1' }, home)

    const result = await retryPendingDeletions(
      home,
      deps({
        exists: () => true,
        runGit: async (_cwd, args) => (args[1] === 'remove' ? { ok: false, error: 'busy' } : { ok: true }),
        rmrf: async () => ({ ok: false, error: 'busy' }),
        shellRmrf: async () => ({ ok: false, error: 'busy' }),
      }),
    )

    expect(result).toEqual({ removed: 0, remaining: 1 })
    expect(loadPendingDeletions(home)[0]).toMatchObject({ attempts: 1, lastError: 'busy' })
  })

  it('stops retrying after the attempt cap', async () => {
    enqueuePendingDeletion({ mainRepoDir: '/repo', worktreeDir: '/wt/1' }, home)
    const failing = deps({
      exists: () => true,
      runGit: async (_cwd, args) => (args[1] === 'remove' ? { ok: false, error: 'busy' } : { ok: true }),
      rmrf: async () => ({ ok: false, error: 'busy' }),
      shellRmrf: async () => ({ ok: false, error: 'busy' }),
    })

    for (let i = 0; i < 10; i++) await retryPendingDeletions(home, failing)

    expect(loadPendingDeletions(home)).toEqual([])
  })

  it('removes the worktree and clears the entry when the retry succeeds', async () => {
    enqueuePendingDeletion({ mainRepoDir: '/repo', worktreeDir: '/wt/1' }, home)
    let gone = false

    const result = await retryPendingDeletions(
      home,
      deps({
        exists: (dir) => (dir === '/wt/1' ? !gone : true),
        runGit: async (_cwd, args) => {
          if (args[1] === 'remove') gone = true
          return { ok: true }
        },
      }),
    )

    expect(result).toEqual({ removed: 1, remaining: 0 })
    expect(loadPendingDeletions(home)).toEqual([])
  })
})
