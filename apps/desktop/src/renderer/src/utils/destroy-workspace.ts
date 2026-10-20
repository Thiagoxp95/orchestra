import { useAppStore } from '../store/app-store'

/**
 * Remove a workspace from Orchestra: disable its webhooks, kill every session
 * in every tree and drop it from the store. Nothing on disk is touched. Shared
 * by the sidebar's delete button and MCP delete_workspace.
 */
export function destroyWorkspace(id: string): void {
  const state = useAppStore.getState()
  const ws = state.workspaces[id]
  if (!ws) return
  for (const action of ws.customActions) {
    if (action.webhookToken) {
      window.electronAPI.webhookDisable(id, action.id, action.webhookToken).catch(() => {})
    }
  }
  for (const tree of ws.trees) {
    for (const sid of tree.sessionIds) window.electronAPI.killTerminal(sid)
  }
  state.deleteWorkspace(id)
}
