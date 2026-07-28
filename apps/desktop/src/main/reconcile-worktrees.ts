import { existsSync } from 'fs'
import type { PersistedData, WorkspaceTree } from '../shared/types'

export interface ReconcileResult {
  data: PersistedData
  removedTrees: number
  removedSessions: number
  /** The pruned trees themselves, so callers can back them up before saving. */
  prunedTrees: { workspaceId: string; tree: WorkspaceTree }[]
  /** Full records (incl. scrollback) of the sessions dropped with those trees. */
  prunedSessions: PersistedData['sessions']
}

/**
 * Worktrees deleted out-of-band leave a stale entry in the persisted store.
 *
 * When an agent self-removes its `.claude/worktrees/*` tree, or the user runs
 * `git worktree remove` / `rm -rf` outside the app, Orchestra never runs its own
 * removeWorktree path — so the tree (and its now-dead sessions) linger in the
 * store and keep getting mirrored to the web/phone, which faithfully renders a
 * worktree whose directory is long gone.
 *
 * This prunes any non-main tree whose `rootDir` no longer exists on disk, drops
 * the sessions that lived in it, and repairs each workspace's activeTreeIndex /
 * lastActiveSessionId plus the global activeSessionId.
 *
 * Safety rails (this runs at startup and persists synchronously, so a wrong prune
 * is permanent data loss):
 *  - The main repo (tree index 0) is never pruned.
 *  - We only prune a workspace's child worktrees when its main repo IS on disk.
 *    `existsSync` can't tell "deleted" from "volume temporarily unmounted/asleep"
 *    (USB/SMB/NFS) — but a git worktree lives on the same volume as the main repo
 *    it points at, so if the main repo is present the volume is reachable and a
 *    missing child is a genuine deletion. If the main repo itself is missing, the
 *    whole workspace is skipped, so an offline disk never destroys sessions.
 *  - A session id still referenced by a kept tree is never removed (defends a
 *    corrupt store where an id appears under more than one tree).
 *
 * The prune happens in the REAL store rather than only in the mirror, because the
 * web addresses trees by index (removeWorktree / spawnInTree carry a treeIndex):
 * filtering only the mirror would desync those indices from the desktop's trees.
 *
 * `exists` is injected for testability; production passes `fs.existsSync`.
 */
export function reconcilePersistedWorktrees(
  data: PersistedData,
  exists: (path: string) => boolean = existsSync,
): ReconcileResult {
  // Tolerate a malformed / pre-migration store — never throw during startup.
  if (!data || !data.workspaces) {
    return { data, removedTrees: 0, removedSessions: 0, prunedTrees: [], prunedSessions: {} }
  }

  let removedTrees = 0
  const removedSessionIds = new Set<string>()
  const keptSessionIds = new Set<string>()
  const prunedTrees: ReconcileResult['prunedTrees'] = []
  const workspaces: PersistedData['workspaces'] = {}

  for (const [wsId, ws] of Object.entries(data.workspaces)) {
    const trees = ws.trees ?? []
    const activeTree = trees[ws.activeTreeIndex]
    // Volume-reachability probe: only prune children when the main repo is on
    // disk (see "Safety rails"). A missing/empty main repo means skip the lot.
    const mainRoot = trees[0]?.rootDir
    const volumeReachable = mainRoot != null && exists(mainRoot)

    const keptTrees: typeof trees = []
    trees.forEach((tree, idx) => {
      const prune = idx !== 0 && volumeReachable && !exists(tree.rootDir)
      if (prune) {
        removedTrees++
        prunedTrees.push({ workspaceId: wsId, tree })
        for (const sid of tree.sessionIds ?? []) removedSessionIds.add(sid)
      } else {
        keptTrees.push(tree)
        for (const sid of tree.sessionIds ?? []) keptSessionIds.add(sid)
      }
    })
    // The active tree may have shifted index or been removed entirely.
    let activeTreeIndex = activeTree ? keptTrees.indexOf(activeTree) : -1
    if (activeTreeIndex < 0) activeTreeIndex = 0
    workspaces[wsId] = { ...ws, trees: keptTrees, activeTreeIndex }
  }

  if (removedTrees === 0) {
    return { data, removedTrees: 0, removedSessions: 0, prunedTrees: [], prunedSessions: {} }
  }

  // Never drop a session that a kept tree still references.
  for (const sid of keptSessionIds) removedSessionIds.delete(sid)

  const sessions: PersistedData['sessions'] = {}
  const prunedSessions: PersistedData['sessions'] = {}
  for (const [sid, s] of Object.entries(data.sessions ?? {})) {
    if (!removedSessionIds.has(sid)) sessions[sid] = s
    else prunedSessions[sid] = s
  }
  for (const ws of Object.values(workspaces)) {
    if (ws.lastActiveSessionId && removedSessionIds.has(ws.lastActiveSessionId)) {
      ws.lastActiveSessionId = null
    }
  }
  const activeSessionId =
    data.activeSessionId && removedSessionIds.has(data.activeSessionId)
      ? null
      : data.activeSessionId

  return {
    data: { ...data, workspaces, sessions, activeSessionId },
    removedTrees,
    removedSessions: removedSessionIds.size,
    prunedTrees,
    prunedSessions,
  }
}
