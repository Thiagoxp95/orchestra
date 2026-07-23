import type { RecentAgentSession, Workspace } from '../../../shared/types'
import { buildAgentResumeCommand } from '../../../shared/action-utils'

export interface TreeMatch {
  workspaceId: string
  treeIndex: number
}

function normalizeDir(dir: string): string {
  return dir.replace(/\/+$/, '')
}

/**
 * Find the workspace tree whose checkout is the directory an agent session ran
 * in, so a resume lands in the worktree it belongs to. When several workspaces
 * share a directory, the currently active one wins.
 */
export function findTreeForCwd(
  workspaces: Record<string, Workspace>,
  cwd: string,
  activeWorkspaceId?: string | null,
): TreeMatch | null {
  const target = normalizeDir(cwd)
  if (!target) return null
  let fallback: TreeMatch | null = null
  for (const [workspaceId, workspace] of Object.entries(workspaces)) {
    const treeIndex = workspace.trees.findIndex((tree) => normalizeDir(tree.rootDir) === target)
    if (treeIndex === -1) continue
    if (workspaceId === activeWorkspaceId) return { workspaceId, treeIndex }
    fallback ??= { workspaceId, treeIndex }
  }
  return fallback
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
  session: RecentAgentSession,
  workspaces: Record<string, Workspace>,
  activeWorkspaceId: string | null,
): ResumePlan | null {
  const command = buildAgentResumeCommand(session.agent, session.sessionId)
  const match = findTreeForCwd(workspaces, session.cwd, activeWorkspaceId)
  if (match) return { ...match, command }
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
