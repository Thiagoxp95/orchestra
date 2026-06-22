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
}
