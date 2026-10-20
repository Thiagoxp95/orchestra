import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'
import { destroyWorkspace } from '../utils/destroy-workspace'
import type { CustomAction } from '../../../shared/types'

/** What a new action gets when the MCP client leaves a field out. */
const NEW_ACTION: Omit<CustomAction, 'id' | 'name'> = {
  icon: '__terminal__', command: '', actionType: 'cli', keybinding: '', runOnWorktreeCreation: false,
}

/**
 * Runs custom actions triggered from the web remote control. The bridge (main)
 * forwards a `remote-run-action` IPC event; we look up the action and run it
 * exactly like a NavBar tap — active tree, focus on creation — so the web can
 * auto-attach to the spawned session. (This differs from the webhook path,
 * which forces the default tree for unattended runs.)
 */
export function useRemoteActions(): void {
  useEffect(() => {
    return window.electronAPI.onRemoteRunAction(({ workspaceId, actionId }) => {
      const state = useAppStore.getState()
      const workspace = state.workspaces[workspaceId]
      if (!workspace) return
      const action = workspace.customActions.find((a) => a.id === actionId)
      if (!action) return
      state.runAction(workspaceId, action)
    })
  }, [])

  // Web swipe-to-trash: the bridge already killed the PTY; remove the session
  // from the store so the row disappears from the synced sidebar (the persist
  // re-pushes state without it), mirroring the desktop "close" path.
  useEffect(() => {
    return window.electronAPI.onRemoteKillSession((sessionId) => {
      useAppStore.getState().deleteSession(sessionId)
    })
  }, [])

  // Pin / rename from the phone. Store-only, so the change lands in the next
  // state push and the phone's optimistic row is reconciled by the round trip.
  useEffect(() => {
    return window.electronAPI.onRemoteSetSessionPinned(({ sessionId, pinned }) => {
      useAppStore.getState().setSessionPinned(sessionId, pinned)
    })
  }, [])

  useEffect(() => {
    return window.electronAPI.onRemoteRenameSession(({ sessionId, title }) => {
      useAppStore.getState().renameSession(sessionId, title)
    })
  }, [])

  // MCP edits to workspaces, worktrees, actions and session order. The store
  // ignores unknown ids, and the next state push mirrors the result back.
  useEffect(() => {
    return window.electronAPI.onRemoteEdit((edit) => {
      const state = useAppStore.getState()
      switch (edit.kind) {
        case 'updateWorkspace':
          state.updateWorkspace(edit.workspaceId, edit.updates)
          break
        case 'deleteWorkspace':
          destroyWorkspace(edit.workspaceId)
          break
        case 'updateWorktree':
          state.updateWorktreeDisplayName(edit.workspaceId, edit.treeIndex, edit.displayName)
          break
        case 'saveAction': {
          const ws = state.workspaces[edit.workspaceId]
          if (!ws) break
          if (ws.customActions.some((a) => a.id === edit.action.id)) {
            state.updateCustomAction(edit.workspaceId, edit.action.id, edit.action)
          } else {
            state.addCustomAction(edit.workspaceId, { ...NEW_ACTION, name: 'Action', ...edit.action })
          }
          break
        }
        case 'deleteAction':
          state.deleteCustomAction(edit.workspaceId, edit.actionId)
          break
        case 'moveSession':
          state.moveSession(edit.sessionId, edit.direction)
          break
      }
    })
  }, [])

  // Focusing (attach) or typing into a session from the phone acknowledges its
  // pending "needs input" signal, mirroring the desktop's setActiveSession and
  // keystroke paths — the store change re-mirrors state without the attention
  // entry, so the phone's badge drops back to idle.
  useEffect(() => {
    return window.electronAPI.onRemoteAcknowledgeAttention((sessionId) => {
      const state = useAppStore.getState()
      if (state.sessionNeedsUserInput[sessionId]) state.clearSessionNeedsUserInput(sessionId)
    })
  }, [])
}
