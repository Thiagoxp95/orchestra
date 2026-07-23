// Canonical branch ↔ Linear-identifier logic, shared by main (state mirror,
// ticket orchestrator) and renderer (sidebar badges). Pure — no env deps.

const PATTERN = /(?:^|[/\-])([a-zA-Z]{2,5})-(\d+)(?=$|[/\-])/

/** Pull a Linear identifier (e.g. "ENG-4504") out of a git branch name, or null. */
export function extractLinearIdentifier(branch: string): string | null {
  const match = PATTERN.exec(branch)
  if (!match) return null
  return `${match[1].toUpperCase()}-${match[2]}`
}

/**
 * Build a branch name that embeds `identifier` so extractLinearIdentifier picks it
 * up — used to link a freshly generated ticket to its worktree. If the current
 * branch already resolves to this identifier it's returned unchanged; otherwise the
 * lowercased identifier is prepended (dropping a leading conventional-commit type
 * prefix like `feat/` so we don't bury the id). Falls back to the ticket slug when
 * there's no usable current branch (detached HEAD).
 */
export function buildLinkedBranchName(currentBranch: string, identifier: string, titleSlug?: string): string {
  const id = identifier.toLowerCase()
  if (extractLinearIdentifier(currentBranch) === identifier) return currentBranch
  const base = currentBranch.replace(/^[a-z]+\//i, '').trim() || (titleSlug ?? '').trim()
  return base ? `${id}-${base}` : id
}

/** Lowercase, hyphenate, strip to a safe git-branch slug. */
export function slugifyForBranch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}
