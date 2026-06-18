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
