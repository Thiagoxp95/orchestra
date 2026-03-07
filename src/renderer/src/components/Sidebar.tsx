import { useAppStore } from '../store/app-store'
import { SessionItem } from './SessionItem'

export function Sidebar() {
  const workspaces = useAppStore((s) => s.workspaces)
  const sessions = useAppStore((s) => s.sessions)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const createSession = useAppStore((s) => s.createSession)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const setActiveSession = useAppStore((s) => s.setActiveSession)

  const workspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const workspaceSessions = workspace
    ? workspace.sessionIds.map((id) => sessions[id]).filter(Boolean)
    : []

  const sidebarColor = workspace?.color ?? '#12121e'

  const handleCreateSession = () => {
    if (!activeWorkspaceId || !workspace) return
    const sessionId = createSession(activeWorkspaceId)
    if (sessionId) {
      window.electronAPI.createTerminal(sessionId, { cwd: workspace.rootDir })
    }
  }

  const handleDeleteSession = (sessionId: string) => {
    window.electronAPI.killTerminal(sessionId)
    deleteSession(sessionId)
  }

  return (
    <div
      className="w-56 flex flex-col border-r border-white/5 transition-colors duration-300"
      style={{ backgroundColor: sidebarColor + '20' }}
    >
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {workspaceSessions.map((session) => (
          <SessionItem
            key={session.id}
            label={session.label}
            processStatus={session.processStatus}
            isActive={session.id === activeSessionId}
            accentColor={workspace?.color ?? '#6366f1'}
            onClick={() => setActiveSession(session.id)}
            onDelete={() => handleDeleteSession(session.id)}
          />
        ))}
        {workspaceSessions.length === 0 && (
          <p className="text-gray-500 text-sm text-center py-4">No sessions yet</p>
        )}
      </div>
      <div className="p-2 border-t border-white/5">
        <button
          onClick={handleCreateSession}
          disabled={!activeWorkspaceId}
          className="w-full px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-white/5 rounded-md transition-colors disabled:opacity-50"
        >
          + New Session
        </button>
      </div>
    </div>
  )
}
