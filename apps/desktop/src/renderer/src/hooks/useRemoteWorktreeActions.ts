import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'
import {
  CLAUDE_INTERACTIVE_COMMAND_PREVIEW,
  CODEX_INTERACTIVE_COMMAND_PREVIEW,
  CURSOR_INTERACTIVE_COMMAND_PREVIEW,
} from '../../../shared/action-utils'

/**
 * Web-triggered actions on an existing tree (worktree):
 *  - `remote-spawn-in-tree`: open a terminal/agent or run a custom action in a
 *    specific tree. Sets the active workspace+tree first so the spawn/action lands
 *    there, then the new session focus mirrors back so the web can auto-attach.
 *  - `remote-remove-worktree`: kill the tree's sessions, remove the worktree on
 *    disk, and drop it from the store (never the main repo at index 0).
 *
 * Both are fire-and-forget from the web's perspective; the desktop is the source
 * of truth and mirrors the resulting state back.
 */
export function useRemoteWorktreeActions(): void {
  useEffect(() => {
    return window.electronAPI.onRemoteSpawnInTree(({ workspaceId, treeIndex, agent, actionId }) => {
      const state = useAppStore.getState()
      const ws = state.workspaces[workspaceId]
      if (!ws || !ws.trees[treeIndex]) return
      state.setActiveWorkspace(workspaceId)
      state.setActiveTree(workspaceId, treeIndex)
      if (agent) {
        // Use the same full launch commands as the local spin-up buttons so
        // mobile-spawned agents inherit bypass permissions (Claude's
        // --dangerously-skip-permissions, Codex's --dangerously-bypass-approvals-
        // and-sandbox). Bare `claude`/`codex` here meant remote sessions hit the
        // interactive permission prompt — which the phone can't easily answer.
        const initialCommand =
          agent === 'claude' ? CLAUDE_INTERACTIVE_COMMAND_PREVIEW
          : agent === 'codex' ? CODEX_INTERACTIVE_COMMAND_PREVIEW
          : agent === 'cursor' ? CURSOR_INTERACTIVE_COMMAND_PREVIEW
          : undefined
        state.createSession(workspaceId, initialCommand, undefined, undefined, undefined, agent, undefined, treeIndex)
      } else if (actionId) {
        const action = ws.customActions.find((a) => a.id === actionId)
        if (action) state.runAction(workspaceId, action)
      }
    })
  }, [])

  useEffect(() => {
    return window.electronAPI.onRemoteRemoveWorktree(({ workspaceId, treeIndex }) => {
      if (treeIndex === 0) return // never remove the main repo
      const state = useAppStore.getState()
      const ws = state.workspaces[workspaceId]
      const tree = ws?.trees[treeIndex]
      if (!ws || !tree) return
      for (const sid of tree.sessionIds) window.electronAPI.killTerminal(sid)
      const mainRoot = ws.trees[0].rootDir
      void window.electronAPI
        .removeWorktree(mainRoot, tree.rootDir)
        .catch(() => {})
        .finally(() => {
          useAppStore.getState().removeWorktree(workspaceId, treeIndex)
        })
    })
  }, [])
}
