import { useAppStore } from '../store/app-store'

export const DEFAULT_WORKSPACE_COLOR = '#6366f1'

/**
 * The New Workspace flow: pick up the repo's shared settings, create the
 * workspace (default actions unless the repo ships its own), focus it and start
 * its first terminal. Shared by the dialog and MCP create_workspace.
 */
export async function addWorkspace(name: string, color: string, rootDir: string, emoji?: string): Promise<string> {
  const repositorySettings = await window.electronAPI.getRepositoryWorkspaceSettings(rootDir)
  const { createWorkspace, updateWorkspace } = useAppStore.getState()
  const workspaceId = createWorkspace(name, color, rootDir, repositorySettings)
  if (emoji) updateWorkspace(workspaceId, { emoji })
  const ws = useAppStore.getState().workspaces[workspaceId]
  const tree = ws?.trees[ws.activeTreeIndex]
  if (tree?.sessionIds[0]) {
    window.electronAPI.prewarmTerminal({ cwd: rootDir })
    window.electronAPI.createTerminal(tree.sessionIds[0], { cwd: rootDir })
  }
  return workspaceId
}
