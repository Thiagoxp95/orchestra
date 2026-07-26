import type { RecentAgentSession, Workspace } from '../../../shared/types'
import { buildAgentResumeCommand } from '../../../shared/action-utils'

export interface TreeMatch {
  workspaceId: string
  treeIndex: number
  /** False when the session ran in a subdirectory *inside* the tree, not at its root. */
  exact: boolean
}

function normalizeDir(dir: string): string {
  return dir.replace(/\/+$/, '')
}

/**
 * Find the workspace tree whose checkout is the directory an agent session ran
 * in, so a resume lands in the worktree it belongs to. When several workspaces
 * share a directory, the currently active one wins.
 *
 * Agents are routinely run from a subdirectory of a checkout (`apps/web`, a
 * scratchpad under the repo). Those sessions belong to that tree just as much as
 * one started at its root, so a directory with no tree of its own falls back to
 * the DEEPEST tree that contains it — a worktree nested under the main checkout
 * therefore claims its own subdirectories instead of losing them to the parent.
 * Callers must respect `exact`: a resume still has to run in the recorded
 * directory (see planResume).
 */
export function findTreeForCwd(
  workspaces: Record<string, Workspace>,
  cwd: string,
  activeWorkspaceId?: string | null,
): TreeMatch | null {
  const target = normalizeDir(cwd)
  if (!target) return null
  let exactFallback: TreeMatch | null = null
  let nested: TreeMatch | null = null
  let nestedDepth = -1
  for (const [workspaceId, workspace] of Object.entries(workspaces)) {
    for (const [treeIndex, tree] of workspace.trees.entries()) {
      const rootDir = normalizeDir(tree.rootDir)
      if (!rootDir) continue
      if (rootDir === target) {
        if (workspaceId === activeWorkspaceId) return { workspaceId, treeIndex, exact: true }
        exactFallback ??= { workspaceId, treeIndex, exact: true }
      } else if (target.startsWith(`${rootDir}/`) && rootDir.length > nestedDepth) {
        nested = { workspaceId, treeIndex, exact: false }
        nestedDepth = rootDir.length
      }
    }
  }
  // An exact owner anywhere beats a containing tree: the directory IS that tree.
  return exactFallback ?? nested
}

export interface ResumePlan {
  workspaceId: string
  treeIndex: number
  command: string
  /** Set only when the session's directory isn't the tree's own checkout. */
  cwdOverride?: string
}

/**
 * Decide where a resumed session should spawn. Preference is the tree that owns
 * the session's directory; otherwise it spawns under the active workspace but
 * still runs in the original directory, because `claude --resume` / `codex
 * resume` only resolve a session id from the directory it was recorded in.
 */
export function planResume(
  session: Pick<RecentAgentSession, 'agent' | 'sessionId' | 'cwd'>,
  workspaces: Record<string, Workspace>,
  activeWorkspaceId: string | null,
): ResumePlan | null {
  const command = buildAgentResumeCommand(session.agent, session.sessionId)
  const match = findTreeForCwd(workspaces, session.cwd, activeWorkspaceId)
  if (match) {
    return {
      workspaceId: match.workspaceId,
      treeIndex: match.treeIndex,
      command,
      // A session recorded in a subdirectory of the tree has to respawn there,
      // for the same reason the no-match branch below keeps its directory.
      cwdOverride: match.exact ? undefined : session.cwd,
    }
  }
  if (!activeWorkspaceId) return null
  const workspace = workspaces[activeWorkspaceId]
  if (!workspace) return null
  return {
    workspaceId: activeWorkspaceId,
    treeIndex: workspace.activeTreeIndex,
    command,
    cwdOverride: session.cwd,
  }
}
