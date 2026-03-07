import { useEffect } from 'react'
import { NavBar } from './components/NavBar'
import { Sidebar } from './components/Sidebar'
import { TerminalArea } from './components/TerminalArea'
import { useProcessStatus } from './hooks/useProcessStatus'
import { useAppStore } from './store/app-store'
import type { PersistedData } from '../../shared/types'

export function App() {
  const loadPersistedState = useAppStore((s) => s.loadPersistedState)
  useProcessStatus()

  useEffect(() => {
    // Load persisted data on startup
    window.electronAPI.getPersistedData().then((data: PersistedData | null) => {
      if (data && Object.keys(data.workspaces).length > 0) {
        // Strip scrollback/env from session data for Zustand
        const sessions: Record<string, any> = {}
        for (const [id, session] of Object.entries(data.sessions)) {
          const { scrollback, env, ...rest } = session
          sessions[id] = rest
        }
        loadPersistedState(data.workspaces, sessions, data.activeWorkspaceId, data.activeSessionId)
        // Recreate PTYs for each persisted session
        for (const [id, session] of Object.entries(data.sessions)) {
          window.electronAPI.createTerminal(id, { cwd: session.cwd })
        }
      }
    })

    // Handle terminal exits — don't auto-delete, just log
    // The user can manually close sessions from the sidebar
    window.electronAPI.onTerminalExit((_sessionId: string) => {
      // Session PTY exited — terminal will stop receiving data
      // but we keep the session in the sidebar so it's not confusing
    })

    return () => {
      window.electronAPI.removeAllListeners()
    }
  }, [])

  // Auto-save state changes (debounced)
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>
    const unsub = useAppStore.subscribe((state) => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        window.electronAPI.saveState({
          workspaces: state.workspaces,
          sessions: state.sessions,
          activeWorkspaceId: state.activeWorkspaceId,
          activeSessionId: state.activeSessionId
        })
      }, 1000)
    })
    return () => {
      clearTimeout(timeout)
      unsub()
    }
  }, [])

  return (
    <div className="h-screen flex flex-col bg-[#0e0e1a] text-white overflow-hidden">
      <NavBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <TerminalArea />
      </div>
    </div>
  )
}
