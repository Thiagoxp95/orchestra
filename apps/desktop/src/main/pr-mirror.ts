import { execFile } from 'child_process'
import type { GitPRInfo, GitPRState } from '../shared/types'

// The worktree → pull-request lookup, shared by the desktop sidebar (which asks
// over IPC on a 30s poll) and the state mirror (which reads the cache
// synchronously, the same way linear-mirror feeds the linked Linear ticket).
//
// One cache for both surfaces on purpose: `gh pr view` shells out through the
// user's login shell and hits the network, so a second poller just for the
// mirror would double that cost and let the phone disagree with the desktop.
// Instead the desktop's own polling keeps the cache warm and the mirror rides
// along — a push that lands between polls carries the last known answer.

const TTL_MS = 20_000
const GH_TIMEOUT_MS = 10_000

interface CacheEntry {
  /** Branch the answer belongs to — a tree that switched branches must not keep the old PR. */
  branch: string
  pr: GitPRInfo | null // null = looked up, no PR for this branch
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>() // rootDir → entry
const inflight = new Map<string, Promise<GitPRInfo | null>>()

// Set by the remote bridge so a PR that opens/merges reaches the phone right
// away instead of on the next heartbeat. Injected (rather than imported) to keep
// this module free of a cycle with remote-bridge, which reads the cache below.
let onChange: (() => void) | null = null

export function setPullRequestChangeListener(cb: () => void): void {
  onChange = cb
}

function fetchPullRequest(cwd: string, branch: string): Promise<GitPRInfo | null> {
  return new Promise((resolve) => {
    // Run gh through the user's login shell so it inherits the full PATH
    // (gh is typically in /usr/local/bin or /opt/homebrew/bin, which aren't
    // in the default PATH for macOS GUI apps launched from Finder/Dock).
    const loginShell = process.env.SHELL || '/bin/sh'
    const escaped = branch.replace(/'/g, "'\\''")
    const cmd = `gh pr view '${escaped}' --json number,state,isDraft,title,url`
    execFile(loginShell, ['-l', '-c', cmd], { cwd, timeout: GH_TIMEOUT_MS }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        const data = JSON.parse(stdout.trim())
        const state: GitPRState = data.isDraft ? 'DRAFT' : data.state // OPEN | CLOSED | MERGED
        resolve({ number: data.number, state, title: data.title ?? '', url: data.url })
      } catch {
        resolve(null)
      }
    })
  })
}

/**
 * Read-through cache. Serves the desktop's IPC poll and, as a side effect, keeps
 * the mirror's synchronous view fresh. Concurrent calls for the same tree share
 * one `gh` invocation.
 */
export async function getPullRequest(cwd: string, branch: string): Promise<GitPRInfo | null> {
  if (!branch) return null
  const hit = cache.get(cwd)
  if (hit && hit.branch === branch && Date.now() - hit.fetchedAt < TTL_MS) return hit.pr
  const pending = inflight.get(cwd)
  if (pending) return pending

  const task = fetchPullRequest(cwd, branch)
    .then((pr) => {
      const prev = cache.get(cwd)
      cache.set(cwd, { branch, pr, fetchedAt: Date.now() })
      if (prev?.branch !== branch || JSON.stringify(prev?.pr ?? null) !== JSON.stringify(pr)) {
        onChange?.()
      }
      return pr
    })
    .finally(() => inflight.delete(cwd))
  inflight.set(cwd, task)
  return task
}

/**
 * Synchronous cache read for sanitizeWorkspaces. Returns undefined when the tree
 * has never been looked up, when its branch has moved on since, or when it has
 * no PR — all of which mean "draw no badge".
 */
export function getCachedPullRequest(rootDir: string, branch: string | undefined): GitPRInfo | undefined {
  if (!branch) return undefined
  const hit = cache.get(rootDir)
  if (!hit || hit.branch !== branch) return undefined
  return hit.pr ?? undefined
}
