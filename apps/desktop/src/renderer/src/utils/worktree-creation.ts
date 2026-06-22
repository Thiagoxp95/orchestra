import type { CustomAction } from '../../../shared/types'

export type SpinUpAgent = 'terminal' | 'claude' | 'codex' | 'cursor'

export interface WorktreeCreationInput {
  branch: string
  selectedActionIds: string[]
  spinUp: SpinUpAgent | null
}

// Dependencies injected by the caller so this flow stays pure and testable.
// The desktop dialog wires its real store actions + local runBackgroundAction;
// the remote hook (useRemoteWorktree) wires store actions from getState() and a
// runBackgroundAction that falls back to an interactive run (the headless
// background machinery is Sidebar-local).
export interface WorktreeCreationDeps {
  workspace: { trees: { rootDir: string }[]; customActions: CustomAction[] }
  worktreesDir: string
  createWorktree: (repoDir: string, branch: string, worktreesDir: string) => Promise<{ success: boolean; path?: string; error?: string }>
  addWorktree: (workspaceId: string, rootDir: string) => void
  runAction: (workspaceId: string, action: CustomAction) => void
  runBackgroundAction: (action: CustomAction) => void
  createSession: (workspaceId: string, initialCommand: string | undefined, processStatus: SpinUpAgent, treeIndex: number) => void
}

/**
 * Creates a git worktree for `workspaceId`, then (on success) runs the selected
 * creation actions and optionally spins up an agent session in the new tree.
 * Returns the IPC result so the caller can decide how to surface failures
 * (desktop dialog → alert; remote hook → no-op).
 */
export async function runWorktreeCreation(
  deps: WorktreeCreationDeps,
  workspaceId: string,
  { branch, selectedActionIds, spinUp }: WorktreeCreationInput,
): Promise<{ success: boolean; error?: string }> {
  const mainRoot = deps.workspace.trees[0].rootDir
  const result = await deps.createWorktree(mainRoot, branch, deps.worktreesDir)
  if (!result.success || !result.path) {
    return { success: false, error: result.error }
  }

  const newTreeIndex = deps.workspace.trees.length // the worktree will be added at this index
  deps.addWorktree(workspaceId, result.path)

  const selectedSet = new Set(selectedActionIds)
  for (const action of deps.workspace.customActions) {
    if (selectedSet.has(action.id)) {
      if (action.runInBackground) deps.runBackgroundAction(action)
      else deps.runAction(workspaceId, action)
    }
  }

  if (spinUp) {
    const initialCommand =
      spinUp === 'claude' ? 'claude' : spinUp === 'codex' ? 'codex' : spinUp === 'cursor' ? 'agent --force --model composer-2-fast' : undefined
    deps.createSession(workspaceId, initialCommand, spinUp, newTreeIndex)
  }

  return { success: true }
}
