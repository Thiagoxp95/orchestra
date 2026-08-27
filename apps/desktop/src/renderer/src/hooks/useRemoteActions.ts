import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'

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
