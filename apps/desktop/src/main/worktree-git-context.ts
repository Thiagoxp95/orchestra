// Collect everything the ticket-drafting agent used to gather for itself.
//
// The agent previously ran `git status`, `git diff`, `git log` and read files as
// tool calls — each one a separate model round-trip, which is what made "Analyzing
// this worktree…" take so long. These same commands cost milliseconds from main,
// so we run them up front and hand the agent a single self-contained prompt.

import { execFile } from 'node:child_process'

/** Keep the prompt bounded — a big refactor's full diff is neither useful nor cheap. */
const MAX_DIFF_CHARS = 40_000
const MAX_BRANCH_DIFF_CHARS = 20_000
const GIT_TIMEOUT_MS = 10_000

/** Run a git command, resolving to '' on any failure — every section is best-effort. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS },
      (err, stdout) => resolve(err ? '' : stdout.trim()),
    )
  })
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (diff truncated here)`
}

function section(heading: string, body: string): string {
  return body ? `### ${heading}\n${body}\n` : ''
}

/**
 * Resolve the branch this worktree forked from, so committed work can be diffed
 * too. Tries the remote's default branch, then the usual local names. Returns
 * null when none of them exist or when HEAD already is that branch.
 */
async function resolveBaseRef(cwd: string): Promise<string | null> {
  const head = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const remoteHead = await git(cwd, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])
  const candidates = [remoteHead, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean)
  for (const ref of candidates) {
    if (ref === head) continue
    // rev-parse --verify writes to stderr on failure, so git() gives us ''.
    if (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) {
      const base = await git(cwd, ['merge-base', ref, 'HEAD'])
      if (base) return base
    }
  }
  return null
}

/**
 * A markdown summary of the work in this worktree, or null when the worktree has
 * nothing to describe (fresh checkout, no commits, no edits) — in which case the
 * caller should let the agent go look for itself.
 */
export async function collectWorktreeGitContext(cwd: string): Promise<string | null> {
  const [branch, status, recentLog, workingStat, workingDiff] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['status', '--porcelain=v1']),
    git(cwd, ['log', '--oneline', '-20']),
    git(cwd, ['diff', '--stat', 'HEAD']),
    git(cwd, ['diff', 'HEAD']),
  ])

  // Committed-but-unmerged work is the bulk of an Orchestra worktree's story, so
  // pull the branch-vs-base view in as well when we can find a base.
  let branchLog = ''
  let branchStat = ''
  let branchDiff = ''
  const base = await resolveBaseRef(cwd)
  if (base) {
    ;[branchLog, branchStat, branchDiff] = await Promise.all([
      git(cwd, ['log', '--oneline', `${base}..HEAD`]),
      git(cwd, ['diff', '--stat', `${base}..HEAD`]),
      git(cwd, ['diff', `${base}..HEAD`]),
    ])
  }

  if (!status && !workingDiff && !recentLog && !branchLog) return null

  const body = [
    section('Current branch', branch),
    section('Commits on this branch (not yet on the base branch)', branchLog),
    section('Recent commits', branchLog ? '' : recentLog),
    section('Working tree status (git status --porcelain)', status),
    section('Committed changes vs base — files', branchStat),
    section('Committed changes vs base — diff', clamp(branchDiff, MAX_BRANCH_DIFF_CHARS)),
    section('Uncommitted changes — files', workingStat),
    section('Uncommitted changes — diff', clamp(workingDiff, MAX_DIFF_CHARS)),
  ].join('')

  return body.trim() || null
}
