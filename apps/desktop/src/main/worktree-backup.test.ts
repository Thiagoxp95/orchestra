import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import {
  BACKUP_RETENTION_MS,
  backupPrunedTrees,
  backupWorktree,
  listWorktreeBackups,
  pruneOldBackups,
  restoreWorktreeBackup,
  sessionsUnderDir,
  snapshotStoreIfStale,
} from './worktree-backup'
import type { PersistedData } from '../shared/types'

let tmp: string
let repo: string
let backups: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

function session(id: string, cwd: string): PersistedData['sessions'][string] {
  return { id, cwd, label: id, scrollback: 'saved output', env: {} } as unknown as PersistedData['sessions'][string]
}

beforeAll(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'wt-backup-'))
  backups = join(tmp, 'backups')
  repo = join(tmp, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@test')
  git(repo, 'config', 'user.name', 'Test')
  fs.writeFileSync(join(repo, 'a.txt'), 'hello\n')
  fs.writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'init')
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('backupWorktree + restoreWorktreeBackup round trip', () => {
  it('captures uncommitted work and untracked files, then restores them', async () => {
    const wt = join(tmp, 'wt-feature')
    git(repo, 'worktree', 'add', '-b', 'feature', wt)

    // Dirty tracked file, untracked file, and an ignored file that must NOT be captured.
    fs.writeFileSync(join(wt, 'a.txt'), 'hello\nedited\n')
    fs.mkdirSync(join(wt, 'sub'))
    fs.writeFileSync(join(wt, 'sub', 'new.txt'), 'untracked content\n')
    fs.writeFileSync(join(wt, 'ignored.txt'), 'should not be backed up\n')

    const id = await backupWorktree({
      mainRepoDir: repo,
      worktreeDir: wt,
      reason: 'delete',
      sessions: { s1: session('s1', wt) },
      backupsRoot: backups,
      now: 1000,
    })
    expect(id).toBeTruthy()

    const metas = listWorktreeBackups(repo, backups)
    expect(metas).toHaveLength(1)
    expect(metas[0].branch).toBe('feature')
    expect(metas[0].dirty).toBe(true)
    expect(metas[0].untrackedCount).toBe(1)
    expect(metas[0].sessionCount).toBe(1)

    // Destroy the worktree the way the app does.
    git(repo, 'worktree', 'remove', '--force', wt)
    expect(fs.existsSync(wt)).toBe(false)

    const restored = await restoreWorktreeBackup(id!, backups)
    expect(restored.success).toBe(true)
    expect(restored.error).toBeUndefined()
    expect(fs.readFileSync(join(wt, 'a.txt'), 'utf-8')).toBe('hello\nedited\n')
    expect(fs.readFileSync(join(wt, 'sub', 'new.txt'), 'utf-8')).toBe('untracked content\n')
    expect(fs.existsSync(join(wt, 'ignored.txt'))).toBe(false)
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature')
  })

  it('recreates a deleted branch at the backed-up commit', async () => {
    const wt = join(tmp, 'wt-doomed')
    git(repo, 'worktree', 'add', '-b', 'doomed', wt)
    fs.writeFileSync(join(wt, 'b.txt'), 'work\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-m', 'wip')
    const sha = git(wt, 'rev-parse', 'HEAD').trim()

    const id = await backupWorktree({
      mainRepoDir: repo, worktreeDir: wt, reason: 'cleanup', backupsRoot: backups, now: 2000,
    })
    git(repo, 'worktree', 'remove', '--force', wt)
    git(repo, 'branch', '-D', 'doomed')

    const restored = await restoreWorktreeBackup(id!, backups)
    expect(restored.success).toBe(true)
    expect(git(wt, 'rev-parse', 'HEAD').trim()).toBe(sha)
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('doomed')
    git(repo, 'worktree', 'remove', '--force', wt)
    git(repo, 'branch', '-D', 'doomed')
  })

  it('refuses to restore over an existing path', async () => {
    const metas = listWorktreeBackups(repo, backups)
    const existing = metas.find((m) => m.branch === 'feature')!
    const result = await restoreWorktreeBackup(existing.id, backups)
    expect(result.success).toBe(false)
    expect(result.error).toContain('already exists')
  })

  it('returns null for a directory that is already gone', async () => {
    const id = await backupWorktree({
      mainRepoDir: repo, worktreeDir: join(tmp, 'nope'), reason: 'delete', backupsRoot: backups,
    })
    expect(id).toBeNull()
  })
})

describe('store snapshots + retention', () => {
  it('snapshots the store file, then skips while fresh', () => {
    const storeFile = join(tmp, 'orchestra-data.json')
    fs.writeFileSync(storeFile, '{"data":{}}')
    const first = snapshotStoreIfStale(storeFile, backups, 10_000)
    expect(first).toBeTruthy()
    // Within the 6h freshness window — skipped.
    expect(snapshotStoreIfStale(storeFile, backups, 20_000)).toBeNull()
    // Past the window — snapshots again.
    expect(snapshotStoreIfStale(storeFile, backups, 10_000 + 7 * 60 * 60 * 1000)).toBeTruthy()
  })

  it('prunes expired backups but always keeps the newest store snapshot', () => {
    const now = 10_000 + BACKUP_RETENTION_MS * 2
    // Both worktree backups (createdAt 1000/2000) and both snapshots are far past retention.
    pruneOldBackups(backups, now)
    expect(listWorktreeBackups(undefined, backups)).toHaveLength(0)
    const snaps = fs.readdirSync(join(backups, 'store'))
    expect(snaps).toHaveLength(1)
  })
})

describe('backupPrunedTrees', () => {
  it('writes the pruned trees and their sessions to a dated file', () => {
    const file = backupPrunedTrees(
      [{ workspaceId: 'w1', tree: { rootDir: '/x/gone', sessionIds: ['s1'] } }],
      { s1: session('s1', '/x/gone') },
      backups,
      3000,
    )
    expect(file).toBeTruthy()
    const parsed = JSON.parse(fs.readFileSync(file!, 'utf-8'))
    expect(parsed.pruned[0].tree.rootDir).toBe('/x/gone')
    expect(parsed.sessions.s1.scrollback).toBe('saved output')
  })

  it('returns null when nothing was pruned', () => {
    expect(backupPrunedTrees([], {}, backups)).toBeNull()
  })
})

describe('sessionsUnderDir', () => {
  it('matches only sessions inside the worktree, not sibling prefixes', () => {
    const sessions = {
      inside: session('inside', '/repo/wt/sub'),
      exact: session('exact', '/repo/wt'),
      sibling: session('sibling', '/repo/wt-other'),
    } as PersistedData['sessions']
    const out = sessionsUnderDir(sessions, '/repo/wt')
    expect(Object.keys(out).sort()).toEqual(['exact', 'inside'])
  })
})
