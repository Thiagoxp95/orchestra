import { useAppStore } from '../store/app-store'
import { TerminalInstance } from './TerminalInstance'

export function TerminalArea() {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const workspaces = useAppStore((s) => s.workspaces)

  if (!activeWorkspaceId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#1a1a2e] text-gray-500">
        <p>Create a workspace to get started</p>
      </div>
    )
  }

  if (!activeSessionId) {
    const workspace = workspaces[activeWorkspaceId]
    return (
      <div className="flex-1 flex items-center justify-center bg-[#1a1a2e] text-gray-500">
        <p>Create a session in "{workspace?.name}"</p>
      </div>
    )
  }

  return (
    <div className="flex-1 bg-[#1a1a2e] p-1">
      <TerminalInstance key={activeSessionId} sessionId={activeSessionId} />
    </div>
  )
}
