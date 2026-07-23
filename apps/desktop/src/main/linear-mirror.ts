import type { Workspace } from '../shared/types'
import type { LinearIssueDetail } from '../shared/linear-types'
import { decryptStringFromStorage } from './linear-safe-storage'
import { readTreeBranch } from './remote-bridge-sanitize'
import { fetchIssueDetail } from './linear-api'
import { extractLinearIdentifier } from '../shared/linear-branch'

// Resolves each worktree's linked Linear ticket (by branch identifier) into a
// LinearIssueDetail, so the state mirror can carry it to the web with no Linear
// access on the web side. Runs entirely in main: it has the full workspaces
// (including the encrypted linearConfig), safeStorage to decrypt, and fetch.
//
// The fetch is async but sanitizeWorkspaces is a hot synchronous path, so this
// keeps a TTL cache: sanitize reads it synchronously (getCachedLinearIssue) and
// a fire-and-forget resolveLinearIssues refreshes stale/missing entries, calling
// back when a value changes so the bridge can re-push.

const TTL_MS = 60_000

interface CacheEntry {
  detail: LinearIssueDetail | null
  fetchedAt: number
}

const detailCache = new Map<string, CacheEntry>() // identifier → detail (null = looked up, no such issue)
const inflight = new Set<string>()
const decryptCache = new Map<string, string>() // encrypted key → plaintext

function decrypt(encrypted: string): string | null {
  const hit = decryptCache.get(encrypted)
  if (hit) return hit
  try {
    const plain = decryptStringFromStorage(encrypted)
    decryptCache.set(encrypted, plain)
    return plain
  } catch {
    return null
  }
}

// Tolerant wrapper: the mirror degrades to the plain branch name on any error.
async function safeFetchIssueDetail(apiKey: string, identifier: string): Promise<LinearIssueDetail | null> {
  try {
    return await fetchIssueDetail(apiKey, identifier)
  } catch {
    return null
  }
}

/** Synchronous cache read for sanitizeWorkspaces. Returns the resolved detail or undefined. */
export function getCachedLinearIssue(branch: string | undefined): LinearIssueDetail | undefined {
  if (!branch) return undefined
  const id = extractLinearIdentifier(branch)
  if (!id) return undefined
  return detailCache.get(id)?.detail ?? undefined
}

/**
 * Refresh stale/missing linked tickets for the given workspaces. Fire-and-forget:
 * call from pushState; when a cached value changes, `onChange` fires so the bridge
 * re-pushes the mirror. TTL-throttled so repeated calls with fresh caches are cheap
 * and self-limiting (no re-push loop: a just-refreshed entry is < TTL, so the
 * onChange-triggered call finds nothing to fetch).
 */
export async function resolveLinearIssues(
  workspaces: Record<string, Workspace>,
  onChange: () => void,
): Promise<void> {
  const now = Date.now()
  const tasks: Promise<void>[] = []
  for (const w of Object.values(workspaces)) {
    const cfg = w.linearConfig
    if (!cfg?.apiKey) continue
    const apiKey = decrypt(cfg.apiKey)
    if (!apiKey) continue
    for (const t of w.trees) {
      const id = extractLinearIdentifier(readTreeBranch(t.rootDir) ?? '')
      if (!id) continue
      const cached = detailCache.get(id)
      if (cached && now - cached.fetchedAt < TTL_MS) continue
      if (inflight.has(id)) continue
      inflight.add(id)
      tasks.push(
        safeFetchIssueDetail(apiKey, id)
          .then((detail) => {
            const prev = detailCache.get(id)?.detail
            detailCache.set(id, { detail, fetchedAt: Date.now() })
            if (JSON.stringify(prev) !== JSON.stringify(detail)) onChange()
          })
          .finally(() => inflight.delete(id)),
      )
    }
  }
  await Promise.all(tasks)
}

/** Drop a cached entry so the next resolve re-fetches it (e.g. right after we create a ticket). */
export function invalidateLinearIssue(identifier: string): void {
  detailCache.delete(identifier)
}
