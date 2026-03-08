import { useEffect } from 'react'
import { NavBar } from './components/NavBar'
import { Sidebar } from './components/Sidebar'
import { TerminalArea } from './components/TerminalArea'
import { DiffPanel } from './components/DiffPanel'
import { DiffView } from './components/DiffView'
import { useProcessStatus } from './hooks/useProcessStatus'
import { useClaudeResponses } from './hooks/useClaudeResponses'
import { useAppStore } from './store/app-store'
import type { PersistedData } from '../../shared/types'

export function App() {
  const loadPersistedState = useAppStore((s) => s.loadPersistedState)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  useProcessStatus()
  useClaudeResponses()

  const showDiffPanel = useAppStore((s) => s.showDiffPanel)
  const toggleDiffPanel = useAppStore((s) => s.toggleDiffPanel)
  const diffSelectedFile = useAppStore((s) => s.diffSelectedFile)
  const setDiffSelectedFile = useAppStore((s) => s.setDiffSelectedFile)
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

    const unsubClose = window.electronAPI.onCloseActiveSession(() => {
      const { activeSessionId } = useAppStore.getState()
      if (activeSessionId) {
        window.electronAPI.killTerminal(activeSessionId)
        useAppStore.getState().deleteSession(activeSessionId)
      }
    })

    return () => {
      unsubClose()
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
      <div className="flex flex-1 overflow-hidden pt-3 pr-3">
        <Sidebar />
        {diffSelectedFile ? (
          <DiffView file={diffSelectedFile} onClose={() => setDiffSelectedFile(null)} />
        ) : (
          <TerminalArea />
        )}
        {showDiffPanel && <DiffPanel onClose={toggleDiffPanel} />}
      </div>
      <NavBar />
    </div>
  )
}
