import { useEffect } from 'react'
import { NavBar } from './components/NavBar'
import { Sidebar } from './components/Sidebar'
import { TerminalArea } from './components/TerminalArea'
import { useProcessStatus } from './hooks/useProcessStatus'
import { useAppStore } from './store/app-store'
import type { PersistedData } from '../../shared/types'

export function App() {
  const loadPersistedState = useAppStore((s) => s.loadPersistedState)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  useProcessStatus()

  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const panelColor = activeWorkspace?.color ?? '#2a2a3e'

  useEffect(() => {
    window.electronAPI.getPersistedData().then((data: PersistedData | null) => {
      if (data && Object.keys(data.workspaces).length > 0) {
        const sessions: Record<string, any> = {}
        for (const [id, session] of Object.entries(data.sessions)) {
          const { scrollback, env, ...rest } = session
          sessions[id] = rest
        }
        loadPersistedState(data.workspaces, sessions, data.activeWorkspaceId, data.activeSessionId, data.settings)
        // PTYs are now created by useTerminal when xterm mounts and knows its size
      }
    })

    window.electronAPI.onTerminalExit((_sessionId: string) => {})

    return () => {
      window.electronAPI.removeAllListeners()
    }
  }, [])

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>
    const unsub = useAppStore.subscribe((state) => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        const cleanSessions: Record<string, any> = {}
        for (const [id, session] of Object.entries(state.sessions)) {
          const { initialCommand, ...rest } = session
          cleanSessions[id] = rest
        }
        window.electronAPI.saveState({
          workspaces: state.workspaces,
          sessions: cleanSessions,
          activeWorkspaceId: state.activeWorkspaceId,
          activeSessionId: state.activeSessionId,
          settings: state.settings
        })
      }, 1000)
    })
    return () => {
      clearTimeout(timeout)
      unsub()
    }
  }, [])

  return (
    <div
      className="h-screen flex flex-col text-white overflow-hidden transition-colors duration-300"
      style={{ backgroundColor: panelColor }}
    >
      <NavBar />
      <div className="flex flex-1 overflow-hidden pb-2 pr-2">
        <Sidebar />
        <TerminalArea />
      </div>
    </div>
  )
}
