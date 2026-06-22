import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'
import { runWorktreeCreation } from '../utils/worktree-creation'

/**
 * Creates a git worktree triggered from the web remote control. The bridge
 * (main) forwards a `remote-create-worktree` IPC event with the normalized
 * payload; we run the same flow as the desktop dialog via runWorktreeCreation.
 *
 * Background actions run interactively here (runAction with runInBackground
 * cleared): the headless background machinery (toast state, running-set) lives
 * in the Sidebar component and is not reachable from this top-level hook. This
 * matches what runBackgroundAction already does for claude/codex/cursor.
 *
 * Failures are silent on the web side (fire-and-forget); the desktop dialog
 * path is the only one that alerts.
 */
export function useRemoteWorktree(): void {
  useEffect(() => {
    return window.electronAPI.onRemoteCreateWorktree(({ workspaceId, branch, selectedActionIds, spinUp }) => {
      const state = useAppStore.getState()
      const workspace = state.workspaces[workspaceId]
      if (!workspace) return
      void runWorktreeCreation(
        {
          workspace,
          worktreesDir: state.settings.worktreesDir,
          createWorktree: window.electronAPI.createWorktree,
          addWorktree: state.addWorktree,
          runAction: state.runAction,
          runBackgroundAction: (action) => state.runAction(workspaceId, { ...action, runInBackground: false }),
          createSession: (wid, cmd, status, idx) => state.createSession(wid, cmd, undefined, undefined, undefined, status, undefined, idx),
        },
        workspaceId,
        { branch, selectedActionIds, spinUp },
      )
    })
  }, [])
}
