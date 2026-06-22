// Pure helpers for the remote action bar. Kept free of React/Convex imports so
// they can be unit-tested with bun:test like the rest of src/lib.

export interface SafeAction {
  id: string
  name: string
  icon: string
}

export interface SafeWorkspaceLike {
  id: string
  customActions?: SafeAction[]
}

/** The custom actions of the active workspace (empty if none / not found). */
export function selectActiveActions(
  workspaces: SafeWorkspaceLike[] | undefined,
  activeWorkspaceId: string | null | undefined,
): SafeAction[] {
  if (!workspaces || !activeWorkspaceId) return []
  return workspaces.find((w) => w.id === activeWorkspaceId)?.customActions ?? []
}

export type SpinUpAgent = 'terminal' | 'claude' | 'codex' | 'cursor'

export interface SpinUpOption {
  id: SpinUpAgent
  label: string
  icon: string
}

// The spin-up options offered in the worktree dialog, matching the desktop list
// (icons use the same DynamicIcon tokens).
export const SPIN_UP_AGENTS: SpinUpOption[] = [
  { id: 'terminal', label: 'Terminal', icon: '__terminal__' },
  { id: 'claude', label: 'Claude Code', icon: '__claude__' },
  { id: 'codex', label: 'Codex', icon: '__openai__' },
  { id: 'cursor', label: 'Cursor', icon: '__cursor__' },
]

export interface CreateWorktreePayload {
  workspaceId: string
  branch: string
  selectedActionIds: string[]
  spinUp: SpinUpAgent | null
}

/** Builds the `createWorktree` command payload, trimming the branch name. */
export function buildCreateWorktreePayload(
  workspaceId: string,
  branch: string,
  selectedActionIds: string[],
  spinUp: SpinUpAgent | null,
): CreateWorktreePayload {
  return { workspaceId, branch: branch.trim(), selectedActionIds, spinUp }
}

export interface SpawnInTreePayload {
  workspaceId: string
  treeIndex: number
  agent: SpinUpAgent | null
  actionId: string | null
}

/** Builds the `spawnInTree` payload — exactly one of an agent spin-up or a custom action. */
export function buildSpawnInTreePayload(
  workspaceId: string,
  treeIndex: number,
  target: { agent: SpinUpAgent } | { actionId: string },
): SpawnInTreePayload {
  return {
    workspaceId,
    treeIndex,
    agent: 'agent' in target ? target.agent : null,
    actionId: 'actionId' in target ? target.actionId : null,
  }
}
