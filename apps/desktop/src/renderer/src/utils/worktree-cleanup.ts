export interface WorktreeCleanupInput {
  /** Index of the tree within `workspace.trees`. Index 0 is the main repo. */
  treeIndex: number
  /** Latest polled PR info for the tree, if any. */
  pr?: { state: string } | null
  /** Latest polled Linear issue for the tree, if any. */
  linearIssue?: { state: { name: string } } | null
}

// Keywords that mark a Linear ticket as "done" for cleanup. We match by
// substring (not exact equality) because Linear workflows name these states
// in many ways — "Production", "In production", "QA → Production",
// "Staging", "In staging", etc. — and all should count as done.
const DONE_LINEAR_KEYWORDS = ['staging', 'production']

/**
 * A worktree is eligible for bulk cleanup when its work is "done":
 * its PR is closed/merged, or its Linear ticket's state mentions
 * staging/production. The main repo (index 0) is never eligible.
 */
export function isWorktreeCleanupEligible(input: WorktreeCleanupInput): boolean {
  if (input.treeIndex === 0) return false

  const prState = input.pr?.state?.toUpperCase()
  if (prState === 'CLOSED' || prState === 'MERGED') return true

  const linearState = input.linearIssue?.state?.name?.trim().toLowerCase()
  if (linearState && DONE_LINEAR_KEYWORDS.some((kw) => linearState.includes(kw))) return true

  return false
}

/** A worktree being destroyed, snapshotted before the store re-indexes. */
export interface EligibleWorktree {
  treeIndex: number
  rootDir: string
  sessionIds: string[]
}

export interface CleanupDeps {
  /** Custom actions flagged to run when a worktree is destroyed. */
  destructionActions: { name?: string; command: string }[]
  /** Root dir of the main repo (index 0), used as the git worktree owner. */
  mainRoot: string
  killTerminal: (sessionId: string) => void
  /** Remove a tree from the in-memory store (re-indexes the trees array). */
  removeFromStore: (treeIndex: number) => void
  /** Snapshot the tree for point-in-time recovery. Fired before anything is destroyed. */
  backupWorktree: (mainRoot: string, rootDir: string) => Promise<unknown>
  runBackgroundCommand: (cwd: string, command: string) => Promise<{ success: boolean }>
  removeWorktreeOnDisk: (mainRoot: string, rootDir: string) => Promise<{ success: boolean }>
  /** Reports a destruction command that failed (label = action name or command). */
  onCommandFailed?: (label: string) => void
}

/**
 * Tears down worktrees optimistically: the UI is cleared *immediately* and every
 * slow step (backup, destruction commands, on-disk git removal) runs in the
 * background. Deletion is never gated on any of them — a failure can't leave
 * the user staring at a "Deleting…" row, because the backup taken up front makes
 * every outcome recoverable from the restore bin.
 *
 * The synchronous phase — firing the backup, killing sessions, and removing the
 * trees from the store — completes before this function's first `await`, so the
 * worktrees disappear right away no matter how slow (or hung) the rest is. Trees
 * are removed in descending index order so lower indices stay valid as the store
 * splices the array.
 *
 * Ordering inside the background phase matters: the backup must land before the
 * destruction scripts run (they mutate or tear down the very files being
 * captured) and long before the directory is deleted.
 *
 * The returned promise resolves when the background work settles; callers can
 * await it to drive a progress indicator, but must NOT block the UI on it.
 */
export function destroyWorktrees(eligible: EligibleWorktree[], deps: CleanupDeps): Promise<void> {
  // --- Synchronous phase: snapshot, then clear the UI immediately. ---
  // The backup is kicked off (not awaited) before the store mutation so the main
  // process reads the tree's session records while they are still persisted.
  const inFlight = eligible.map((tree) => ({
    rootDir: tree.rootDir,
    backup: deps.backupWorktree(deps.mainRoot, tree.rootDir).catch(() => undefined),
  }))

  for (const tree of eligible) {
    for (const sid of tree.sessionIds) deps.killTerminal(sid)
  }
  // Descending index order keeps lower indices valid as trees are spliced out.
  for (const { treeIndex } of [...eligible].sort((a, b) => b.treeIndex - a.treeIndex)) {
    deps.removeFromStore(treeIndex)
  }

  // --- Background phase: backup → destruction commands → git removal. ---
  return Promise.all(
    inFlight.map(async ({ rootDir, backup }) => {
      await backup
      for (const action of deps.destructionActions) {
        try {
          const result = await deps.runBackgroundCommand(rootDir, action.command)
          if (!result.success) deps.onCommandFailed?.(action.name || action.command)
        } catch {
          deps.onCommandFailed?.(action.name || action.command)
        }
      }
      try {
        await deps.removeWorktreeOnDisk(deps.mainRoot, rootDir)
      } catch {
        // The tree is already gone from the store, and the main process queues
        // anything it couldn't delete for a retry at the next app start.
      }
    }),
  ).then(() => undefined)
}
