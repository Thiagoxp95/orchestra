// Point-in-time recovery for worktrees and agent sessions.
//
// Every path that destroys work — the sidebar delete button, the bulk cleanup
// broom, a remote (phone) delete, and the startup reconcile that prunes trees
// whose directory vanished — first snapshots what is about to be lost into
// ~/.orchestra/backups. A backup captures the branch, HEAD sha, every
// uncommitted change (staged + unstaged, as a binary patch), every untracked
// non-ignored file (copied verbatim), and the session records (including
// scrollback) that lived in the tree. `restoreWorktreeBackup` recreates the
// worktree at its original path and re-applies all of it.
//
// Retention is 7 days (the product requirement is "at least 3"); pruning runs
// at startup and never touches the newest store snapshot.

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { getOrchestraHomeDir } from './orchestra-paths'
import type { PersistedData, WorkspaceTree, WorktreeBackupMeta } from '../shared/types'

export type { WorktreeBackupMeta }

export const BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const STORE_SNAPSHOT_MIN_AGE_MS = 6 * 60 * 60 * 1000
const GIT_TIMEOUT_MS = 30_000
const MAX_GIT_BUFFER = 64 * 1024 * 1024

export interface RestoreResult {
  success: boolean
  path?: string
  error?: string
}

export function getBackupsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(getOrchestraHomeDir(env), 'backups')
}

const worktreesRoot = (root: string): string => join(root, 'worktrees')
const storeRoot = (root: string): string => join(root, 'store')
const prunedRoot = (root: string): string => join(root, 'pruned')

/** Run git resolving to '' on failure — every capture step is best-effort. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: MAX_GIT_BUFFER, timeout: GIT_TIMEOUT_MS },
      (err, stdout) => resolvePromise(err ? '' : stdout),
    )
  })
}

/** Like git() but reports failure — used where we must distinguish "empty" from "failed". */
function gitStrict(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err?: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: MAX_GIT_BUFFER, timeout: GIT_TIMEOUT_MS },
      (err, stdout, stderr) =>
        resolvePromise(err ? { ok: false, out: stdout, err: stderr || err.message } : { ok: true, out: stdout }),
    )
  })
}

function sanitizeForDirName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'unnamed'
}

/**
 * Snapshot a worktree that is about to be destroyed. Returns the backup id, or
 * null when there was nothing to back up (directory already gone) or capture
 * failed. Never throws — a backup failure must not block the destruction path,
 * only get logged by the caller.
 */
export async function backupWorktree(input: {
  mainRepoDir: string
  worktreeDir: string
  reason: WorktreeBackupMeta['reason']
  /** Full session records (with scrollback) that lived in this tree, if known. */
  sessions?: PersistedData['sessions']
  backupsRoot?: string
  now?: number
}): Promise<string | null> {
  const { mainRepoDir, worktreeDir, reason } = input
  const now = input.now ?? Date.now()
  const root = input.backupsRoot ?? getBackupsRoot()
  try {
    if (!fs.existsSync(worktreeDir)) return null

    const branch = (await git(worktreeDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    const headSha = (await git(worktreeDir, ['rev-parse', 'HEAD'])).trim()
    if (!headSha) return null // not a git dir — nothing meaningful to capture

    const id = `${now}-${sanitizeForDirName(basename(mainRepoDir))}-${sanitizeForDirName(branch || 'detached')}`
    const dir = join(worktreesRoot(root), id)
    fs.mkdirSync(dir, { recursive: true })

    // Staged + unstaged changes to tracked files, binary-safe.
    const patch = await git(worktreeDir, ['diff', 'HEAD', '--binary'])
    if (patch.trim()) fs.writeFileSync(join(dir, 'uncommitted.patch'), patch)

    // Untracked, non-ignored files copied verbatim (ls-files honors .gitignore,
    // so node_modules and friends never end up in the backup).
    const untrackedList = (await git(worktreeDir, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean)
    for (const rel of untrackedList) {
      const src = join(worktreeDir, rel)
      const dst = join(dir, 'untracked', rel)
      try {
        fs.mkdirSync(dirname(dst), { recursive: true })
        fs.copyFileSync(src, dst)
      } catch {
        // Skip unreadable files rather than abort the whole backup.
      }
    }

    const sessions = input.sessions ?? {}
    if (Object.keys(sessions).length > 0) {
      fs.writeFileSync(join(dir, 'sessions.json'), JSON.stringify(sessions))
    }

    const meta: WorktreeBackupMeta = {
      id,
      createdAt: now,
      reason,
      mainRepoDir,
      worktreeDir,
      branch: branch === 'HEAD' ? '' : branch,
      headSha,
      dirty: !!patch.trim() || untrackedList.length > 0,
      untrackedCount: untrackedList.length,
      sessionCount: Object.keys(sessions).length,
    }
    fs.writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
    return id
  } catch {
    return null
  }
}

/** List backups newest-first, optionally only those belonging to one main repo. */
export function listWorktreeBackups(mainRepoDir?: string, backupsRoot?: string): WorktreeBackupMeta[] {
  const root = worktreesRoot(backupsRoot ?? getBackupsRoot())
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    return []
  }
  const metas: WorktreeBackupMeta[] = []
  for (const entry of entries) {
    try {
      const meta = JSON.parse(fs.readFileSync(join(root, entry, 'meta.json'), 'utf-8')) as WorktreeBackupMeta
      if (!mainRepoDir || meta.mainRepoDir === mainRepoDir) metas.push(meta)
    } catch {
      // Half-written or foreign directory — skip.
    }
  }
  return metas.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Recreate a backed-up worktree at its original path: `git worktree add` on the
 * original branch (recreating it at the backed-up HEAD if it no longer exists),
 * then re-apply the uncommitted patch and copy untracked files back.
 */
export async function restoreWorktreeBackup(backupId: string, backupsRoot?: string): Promise<RestoreResult> {
  const root = backupsRoot ?? getBackupsRoot()
  const dir = join(worktreesRoot(root), backupId)
  let meta: WorktreeBackupMeta
  try {
    meta = JSON.parse(fs.readFileSync(join(dir, 'meta.json'), 'utf-8'))
  } catch {
    return { success: false, error: 'Backup not found' }
  }
  if (!fs.existsSync(meta.mainRepoDir)) {
    return { success: false, error: `Main repo missing: ${meta.mainRepoDir}` }
  }
  if (fs.existsSync(meta.worktreeDir)) {
    return { success: false, error: `Path already exists: ${meta.worktreeDir}` }
  }

  fs.mkdirSync(dirname(meta.worktreeDir), { recursive: true })
  // A stale registration at this path (e.g. the dir was rm -rf'ed out-of-band)
  // would make `worktree add` refuse; prune first.
  await git(meta.mainRepoDir, ['worktree', 'prune'])

  const branch = meta.branch
  let added = branch
    ? await gitStrict(meta.mainRepoDir, ['worktree', 'add', meta.worktreeDir, branch])
    : { ok: false, out: '', err: 'detached HEAD backup' }
  if (!added.ok) {
    // Branch gone (or detached) — recreate it at the backed-up commit.
    const recreate = branch
      ? ['worktree', 'add', '-b', branch, meta.worktreeDir, meta.headSha]
      : ['worktree', 'add', '--detach', meta.worktreeDir, meta.headSha]
    added = await gitStrict(meta.mainRepoDir, recreate)
  }
  if (!added.ok) return { success: false, error: added.err || 'git worktree add failed' }

  // Reset to the exact backed-up commit — the branch may have moved since.
  if (meta.headSha) await git(meta.worktreeDir, ['reset', '--hard', meta.headSha])

  const patchFile = join(dir, 'uncommitted.patch')
  if (fs.existsSync(patchFile)) {
    const applied = await gitStrict(meta.worktreeDir, ['apply', '--binary', '--whitespace=nowarn', patchFile])
    if (!applied.ok) {
      return {
        success: true,
        path: meta.worktreeDir,
        error: `Worktree restored, but the uncommitted patch failed to apply cleanly: ${applied.err}. The patch is at ${patchFile}`,
      }
    }
  }

  const untrackedDir = join(dir, 'untracked')
  if (fs.existsSync(untrackedDir)) {
    copyDirInto(untrackedDir, meta.worktreeDir)
  }

  return { success: true, path: meta.worktreeDir }
}

function copyDirInto(srcDir: string, dstDir: string): void {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const src = join(entry.parentPath ?? (entry as any).path, entry.name)
    const rel = relative(srcDir, src)
    const dst = join(dstDir, rel)
    try {
      fs.mkdirSync(dirname(dst), { recursive: true })
      fs.copyFileSync(src, dst)
    } catch {
      // Best-effort: one unreadable file shouldn't sink the restore.
    }
  }
}

/**
 * Save the trees (and their full session records) that the startup reconcile is
 * about to prune, so an out-of-band deletion is still recoverable as data even
 * when the directory itself is already gone.
 */
export function backupPrunedTrees(
  pruned: { workspaceId: string; tree: WorkspaceTree }[],
  sessions: PersistedData['sessions'],
  backupsRoot?: string,
  now: number = Date.now(),
): string | null {
  if (pruned.length === 0) return null
  try {
    const dir = prunedRoot(backupsRoot ?? getBackupsRoot())
    fs.mkdirSync(dir, { recursive: true })
    const file = join(dir, `pruned-${now}.json`)
    fs.writeFileSync(file, JSON.stringify({ createdAt: now, pruned, sessions }, null, 2))
    return file
  } catch {
    return null
  }
}

/**
 * Point-in-time copy of the whole persisted store (workspaces, sessions,
 * scrollback). Called at startup and on a slow interval; skipped while the
 * newest snapshot is fresher than 6 hours so long-running apps don't spam.
 */
export function snapshotStoreIfStale(
  storeFilePath: string,
  backupsRoot?: string,
  now: number = Date.now(),
): string | null {
  try {
    if (!fs.existsSync(storeFilePath)) return null
    const dir = storeRoot(backupsRoot ?? getBackupsRoot())
    fs.mkdirSync(dir, { recursive: true })
    const newest = fs
      .readdirSync(dir)
      .map((f) => parseSnapshotTimestamp(f))
      .filter((t): t is number => t !== null)
      .sort((a, b) => b - a)[0]
    if (newest !== undefined && now - newest < STORE_SNAPSHOT_MIN_AGE_MS) return null
    const dst = join(dir, `orchestra-data-${now}.json`)
    fs.copyFileSync(storeFilePath, dst)
    return dst
  } catch {
    return null
  }
}

function parseSnapshotTimestamp(fileName: string): number | null {
  const m = /^orchestra-data-(\d+)\.json$/.exec(fileName)
  return m ? Number(m[1]) : null
}

/**
 * Drop backups older than the retention window. The newest store snapshot is
 * always kept regardless of age, so there is never zero recovery points.
 */
export function pruneOldBackups(backupsRoot?: string, now: number = Date.now()): void {
  const root = backupsRoot ?? getBackupsRoot()
  const cutoff = now - BACKUP_RETENTION_MS

  for (const meta of listWorktreeBackups(undefined, root)) {
    if (meta.createdAt < cutoff) rmrf(join(worktreesRoot(root), meta.id))
  }

  try {
    for (const f of fs.readdirSync(prunedRoot(root))) {
      const m = /^pruned-(\d+)\.json$/.exec(f)
      if (m && Number(m[1]) < cutoff) rmrf(join(prunedRoot(root), f))
    }
  } catch {
    /* dir absent */
  }

  try {
    const snaps = fs
      .readdirSync(storeRoot(root))
      .map((f) => ({ f, t: parseSnapshotTimestamp(f) }))
      .filter((x): x is { f: string; t: number } => x.t !== null)
      .sort((a, b) => b.t - a.t)
    for (const { f, t } of snaps.slice(1)) {
      if (t < cutoff) rmrf(join(storeRoot(root), f))
    }
  } catch {
    /* dir absent */
  }
}

function rmrf(path: string): void {
  try {
    fs.rmSync(path, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

/** Sessions whose cwd sits inside the given worktree — captured into its backup. */
export function sessionsUnderDir(
  sessions: PersistedData['sessions'],
  worktreeDir: string,
): PersistedData['sessions'] {
  const prefix = resolve(worktreeDir) + sep
  const out: PersistedData['sessions'] = {}
  for (const [id, s] of Object.entries(sessions)) {
    const cwd = s.cwd ? resolve(s.cwd) : ''
    if (cwd === resolve(worktreeDir) || cwd.startsWith(prefix)) out[id] = s
  }
  return out
}
