import { useState } from 'react'
import { useAppStore } from '../store/app-store'
import { WorkspaceTab } from './WorkspaceTab'
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog'

export function NavBar() {
  const [showDialog, setShowDialog] = useState(false)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspace)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)

  const sortedWorkspaces = Object.values(workspaces).sort((a, b) => a.createdAt - b.createdAt)
  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const navColor = activeWorkspace?.color ?? '#12121e'

  const handleCreateWorkspace = (name: string, color: string, rootDir: string) => {
    const workspaceId = createWorkspace(name, color, rootDir)
    const workspace = useAppStore.getState().workspaces[workspaceId]
    if (workspace && workspace.sessionIds[0]) {
      window.electronAPI.createTerminal(workspace.sessionIds[0], { cwd: rootDir })
    }
    setShowDialog(false)
  }

  const handleDeleteWorkspace = (id: string) => {
    const workspace = workspaces[id]
    if (workspace) {
      for (const sid of workspace.sessionIds) {
        window.electronAPI.killTerminal(sid)
      }
    }
    deleteWorkspace(id)
  }

  return (
    <>
      <div
        className="flex items-center px-2 pt-2 gap-1 transition-colors duration-300"
        style={{ backgroundColor: navColor + '30', WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {sortedWorkspaces.map((ws) => (
            <WorkspaceTab
              key={ws.id}
              name={ws.name}
              color={ws.color}
              isActive={ws.id === activeWorkspaceId}
              onClick={() => setActiveWorkspace(ws.id)}
              onDelete={() => handleDeleteWorkspace(ws.id)}
            />
          ))}
          <button
            onClick={() => setShowDialog(true)}
            className="px-3 py-2 text-gray-500 hover:text-white transition-colors text-lg"
          >
            +
          </button>
        </div>
      </div>
      {showDialog && (
        <CreateWorkspaceDialog
          onConfirm={handleCreateWorkspace}
          onCancel={() => setShowDialog(false)}
        />
      )}
    </>
  )
}
