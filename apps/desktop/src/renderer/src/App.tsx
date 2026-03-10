import { useEffect, useRef } from 'react'
import { NavBar } from './components/NavBar'
import { Sidebar } from './components/Sidebar'
import { TerminalArea } from './components/TerminalArea'
import { DiffPanel } from './components/DiffPanel'
import { DiffView } from './components/DiffView'
import { useProcessStatus } from './hooks/useProcessStatus'
import { useAgentResponses } from './hooks/useAgentResponses'
import { useAppStore } from './store/app-store'
import { textColor } from './utils/color'
import { ToastContainer } from './components/Toast'
import { useIdleNotifications } from './hooks/useIdleNotifications'
import type { PersistedData } from '../../shared/types'

export function App() {
  const loadPersistedState = useAppStore((s) => s.loadPersistedState)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  useProcessStatus()
  useAgentResponses()
  const { toasts, dismissToast, navigateToSession } = useIdleNotifications()
  const activeSessionId = useAppStore((s) => s.activeSessionId)

  const showDiffPanel = useAppStore((s) => s.showDiffPanel)
  const toggleDiffPanel = useAppStore((s) => s.toggleDiffPanel)
  const diffSelectedFile = useAppStore((s) => s.diffSelectedFile)
  const setDiffSelectedFile = useAppStore((s) => s.setDiffSelectedFile)
  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const panelColor = activeWorkspace?.color ?? '#2a2a3e'
  const prewarmedRootsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    window.electronAPI.getPersistedData().then((data: PersistedData | null) => {
      if (data && Object.keys(data.workspaces).length > 0) {
        const sessions: Record<string, any> = {}
        for (const [id, session] of Object.entries(data.sessions)) {
          const { scrollback, env, ...rest } = session
          sessions[id] = rest
        }
        loadPersistedState(
          data.workspaces,
          sessions,
          data.activeWorkspaceId,
          data.activeSessionId,
          data.settings,
          data.claudeLastResponse,
          data.codexLastResponse,
        )
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

    const unsubLabel = window.electronAPI.onSessionLabelUpdate((sessionId, label) => {
      useAppStore.getState().updateSessionLabel(sessionId, label)
    })

    const unsubNavigate = window.electronAPI.onNavigateToSession((sessionId) => {
      useAppStore.getState().setActiveSession(sessionId)
    })

    return () => {
      unsubClose()
      unsubLabel()
      unsubNavigate()
      window.electronAPI.removeAllListeners()
    }
  }, [])

  useEffect(() => {
    window.electronAPI.navigateToSession(activeSessionId ?? '')
  }, [activeSessionId])

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>
    const unsub = useAppStore.subscribe((state) => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        const cleanSessions: Record<string, any> = {}
        for (const [id, session] of Object.entries(state.sessions)) {
          const { initialCommand, launchProfile, ...rest } = session
          cleanSessions[id] = rest
        }
        window.electronAPI.saveState({
          workspaces: state.workspaces,
          sessions: cleanSessions,
          activeWorkspaceId: state.activeWorkspaceId,
          activeSessionId: state.activeSessionId,
          settings: state.settings,
          claudeLastResponse: state.claudeLastResponse,
          codexLastResponse: state.codexLastResponse
        })
      }, 1000)
    })
    return () => {
      clearTimeout(timeout)
      unsub()
    }
  }, [])

  useEffect(() => {
    for (const workspace of Object.values(workspaces)) {
      for (const tree of workspace.trees) {
        if (prewarmedRootsRef.current.has(tree.rootDir)) continue
        prewarmedRootsRef.current.add(tree.rootDir)
        window.electronAPI.prewarmTerminal({ cwd: tree.rootDir })
      }
    }
  }, [workspaces])

  const isDev = import.meta.env.DEV
  const txtColor = textColor(panelColor)
  const devGridStyle = isDev ? { '--dev-color': `${txtColor}18` } as React.CSSProperties : undefined

  return (
    <div
      className="h-screen flex flex-col text-white overflow-hidden transition-colors duration-300"
      style={{ backgroundColor: panelColor }}
    >
      {isDev && <div className="dev-grid-border h-3 shrink-0" style={devGridStyle} />}
      <div className="flex flex-1 overflow-hidden">
        <div className={`flex flex-1 overflow-hidden ${isDev ? '' : 'pt-3'}`}>
          <Sidebar />
          {diffSelectedFile ? (
            <DiffView file={diffSelectedFile} onClose={() => setDiffSelectedFile(null)} />
          ) : (
            <TerminalArea />
          )}
          {showDiffPanel && <DiffPanel onClose={toggleDiffPanel} />}
        </div>
        {isDev ? (
          <div className="dev-grid-border w-3 shrink-0" style={devGridStyle} />
        ) : (
          <div className="w-3 shrink-0" />
        )}
      </div>
      <NavBar />
      <ToastContainer
        notifications={toasts}
        onDismiss={dismissToast}
        onNavigate={navigateToSession}
      />
    </div>
  )
}
