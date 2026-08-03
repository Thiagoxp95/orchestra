// Disk-side worktree destruction.
//
// Deleting a worktree from the sidebar is optimistic: the tree disappears from
// the UI immediately and everything here runs in the background. That makes the
// on-disk removal fully responsible for eventually succeeding — nobody is
// watching a spinner to retry it by hand.
//
// The failure that motivated this is transient: `git worktree remove` dies with
// EMFILE/ENFILE ("Too many open files in system") when a lot of agents/PTYs are
// alive, and succeeds seconds later once those file descriptors are released.
// So removal is a retry ladder (git remove → prune + fs.rm → shell rm -rf) run
// over a few attempts with backoff, and anything still unremoved after that is
// queued to `pending-deletions.json` and retried at the next app start.

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { getOrchestraHomeDir } from './orchestra-paths'

/** Backoff between removal attempts; length + 1 = total attempts. */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000]
const GIT_TIMEOUT_MS = 60_000
/** Stop retrying a queued deletion after this many app starts. */
const PENDING_MAX_ATTEMPTS = 10

export interface RemovalResult {
  success: boolean
  error?: string
  /** How many attempts it took (1 = first try). */
  attempts?: number
}

export interface PendingDeletion {
  mainRepoDir: string
  worktreeDir: string
  queuedAt: number
  /** Sweeps already spent on this entry (excluding the original removal). */
  attempts: number
  lastError?: string
}

export interface RemovalDeps {
  runGit: (cwd: string, args: string[]) => Promise<{ ok: boolean; error?: string }>
  rmrf: (dir: string) => Promise<{ ok: boolean; error?: string }>
  shellRmrf: (dir: string) => Promise<{ ok: boolean; error?: string }>
  exists: (dir: string) => boolean
  delay: (ms: number) => Promise<void>
}

const defaultDeps: RemovalDeps = {
  runGit: (cwd, args) =>
    new Promise((resolve) => {
      execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS }, (err, _stdout, stderr) =>
        resolve(err ? { ok: false, error: (stderr || err.message).trim() } : { ok: true }),
      )
    }),
  rmrf: (dir) =>
    new Promise((resolve) => {
      fs.rm(dir, { recursive: true, force: true }, (err) =>
        resolve(err ? { ok: false, error: err.message } : { ok: true }),
      )
    }),
  shellRmrf: (dir) =>
    new Promise((resolve) => {
      const shell = process.env.SHELL || '/bin/sh'
      execFile(shell, ['-c', `rm -rf ${JSON.stringify(dir)}`], (err, _stdout, stderr) =>
        resolve(err ? { ok: false, error: (stderr || err.message).trim() } : { ok: true }),
      )
    }),
  exists: (dir) => fs.existsSync(dir),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * Remove a worktree's directory and its git registration, retrying through
 * transient failures. Resolves `{ success: false }` only once every attempt has
 * been spent — callers should queue those for a later sweep.
 */
export async function removeWorktreeFromDisk(
  mainRepoDir: string,
  worktreeDir: string,
  overrides: Partial<RemovalDeps> = {},
): Promise<RemovalResult> {
  const deps = { ...defaultDeps, ...overrides }
  let lastError: string | undefined

  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
    // Already gone (previous attempt's rm landed late, or an agent cleaned up
    // after itself) — just drop the registration and call it done.
    if (!deps.exists(worktreeDir)) {
      await deps.runGit(mainRepoDir, ['worktree', 'prune'])
      return { success: true, attempts: attempt }
    }

    const removed = await deps.runGit(mainRepoDir, ['worktree', 'remove', '--force', worktreeDir])
    if (removed.ok) {
      await deps.runGit(mainRepoDir, ['worktree', 'prune'])
      return { success: true, attempts: attempt }
    }
    lastError = removed.error

    // Git refused (dirty tree it can't unlink, EMFILE, stale lock). Drop the
    // registration first so the directory is no longer a live worktree, then
    // delete the files ourselves — node first, shell as the last resort.
    await deps.runGit(mainRepoDir, ['worktree', 'prune'])
    const nodeRm = await deps.rmrf(worktreeDir)
    if (nodeRm.ok && !deps.exists(worktreeDir)) {
      await deps.runGit(mainRepoDir, ['worktree', 'prune'])
      return { success: true, attempts: attempt }
    }
    if (!nodeRm.ok) lastError = nodeRm.error ?? lastError

    const shellRm = await deps.shellRmrf(worktreeDir)
    if (shellRm.ok && !deps.exists(worktreeDir)) {
      await deps.runGit(mainRepoDir, ['worktree', 'prune'])
      return { success: true, attempts: attempt }
    }
    if (!shellRm.ok) lastError = shellRm.error ?? lastError

    const backoff = RETRY_DELAYS_MS[attempt - 1]
    if (backoff !== undefined) await deps.delay(backoff)
  }

  return { success: false, error: lastError ?? 'Failed to remove worktree directory' }
}

function pendingFilePath(homeDir?: string): string {
  return join(homeDir ?? getOrchestraHomeDir(), 'pending-deletions.json')
}

export function loadPendingDeletions(homeDir?: string): PendingDeletion[] {
  try {
    const raw = JSON.parse(fs.readFileSync(pendingFilePath(homeDir), 'utf-8'))
    return Array.isArray(raw) ? (raw as PendingDeletion[]).filter((e) => e?.worktreeDir && e?.mainRepoDir) : []
  } catch {
    return []
  }
}

function savePendingDeletions(entries: PendingDeletion[], homeDir?: string): void {
  const file = pendingFilePath(homeDir)
  try {
    if (entries.length === 0) {
      fs.rmSync(file, { force: true })
      return
    }
    fs.mkdirSync(homeDir ?? getOrchestraHomeDir(), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(entries, null, 2))
  } catch {
    // A queue we can't persist just means one fewer retry — never throw into
    // the destruction path.
  }
}

/** Record a worktree whose files survived every removal attempt. */
export function enqueuePendingDeletion(
  entry: { mainRepoDir: string; worktreeDir: string; lastError?: string },
  homeDir?: string,
  now: number = Date.now(),
): void {
  const entries = loadPendingDeletions(homeDir).filter((e) => e.worktreeDir !== entry.worktreeDir)
  entries.push({ ...entry, queuedAt: now, attempts: 0 })
  savePendingDeletions(entries, homeDir)
}

export function dropPendingDeletion(worktreeDir: string, homeDir?: string): void {
  const entries = loadPendingDeletions(homeDir)
  const next = entries.filter((e) => e.worktreeDir !== worktreeDir)
  if (next.length !== entries.length) savePendingDeletions(next, homeDir)
}

/**
 * Retry every queued deletion once. Entries are dropped when the directory is
 * finally gone, when the owning repo has itself disappeared, or after
 * PENDING_MAX_ATTEMPTS sweeps (at which point manual cleanup is the only
 * sensible answer and we stop burning startup time on it).
 */
export async function retryPendingDeletions(
  homeDir?: string,
  overrides: Partial<RemovalDeps> = {},
): Promise<{ removed: number; remaining: number }> {
  const deps = { ...defaultDeps, ...overrides }
  const entries = loadPendingDeletions(homeDir)
  if (entries.length === 0) return { removed: 0, remaining: 0 }

  const kept: PendingDeletion[] = []
  let removed = 0

  for (const entry of entries) {
    if (!deps.exists(entry.worktreeDir)) {
      removed++
      continue
    }
    if (!deps.exists(entry.mainRepoDir)) continue // repo gone — nothing left to prune against

    const result = await removeWorktreeFromDisk(entry.mainRepoDir, entry.worktreeDir, deps)
    if (result.success) {
      removed++
      continue
    }
    const attempts = entry.attempts + 1
    if (attempts >= PENDING_MAX_ATTEMPTS) {
      console.warn(
        `[worktree] giving up on removing ${entry.worktreeDir} after ${attempts} attempts: ${result.error}`,
      )
      continue
    }
    kept.push({ ...entry, attempts, lastError: result.error })
  }

  savePendingDeletions(kept, homeDir)
  return { removed, remaining: kept.length }
}
