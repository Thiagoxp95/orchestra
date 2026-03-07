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

  // When a workspace is created, also create its first terminal via IPC
  const handleCreateWorkspace = (name: string, color: string) => {
    const workspaceId = createWorkspace(name, color)
    // The store auto-creates a session. Get its ID and spawn PTY
    const workspace = useAppStore.getState().workspaces[workspaceId]
    if (workspace && workspace.sessionIds[0]) {
      window.electronAPI.createTerminal(workspace.sessionIds[0], { cwd: '~' })
    }
    setShowDialog(false)
  }

  // When deleting a workspace, kill all its PTYs
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
      <div className="flex items-center bg-[#12121e] px-2 pt-2 gap-1" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="flex items-center gap-1 no-drag" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
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
