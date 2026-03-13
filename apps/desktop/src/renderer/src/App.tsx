import { useState, useEffect, useRef } from 'react'
import { NavBar } from './components/NavBar'
import { Sidebar } from './components/Sidebar'
import { TerminalArea } from './components/TerminalArea'
import { DiffPanel } from './components/DiffPanel'
import { DiffView } from './components/DiffView'
import { useProcessStatus } from './hooks/useProcessStatus'
import { useAgentResponses } from './hooks/useAgentResponses'
import { useAppStore, getActiveTree } from './store/app-store'
import { textColor, diffColors } from './utils/color'
import { ToastContainer } from './components/Toast'
import { useIdleNotifications } from './hooks/useIdleNotifications'
import { AutomationRunsPanel } from './components/AutomationRunsPanel'
import { useAutomations } from './hooks/useAutomations'
import { AutomationDebugOverlay } from './components/AutomationDebugOverlay'
import { MaestroMode } from './components/MaestroMode'
import { matchesKeybinding, getBinding } from './keybindings'
import type { PersistedData } from '../../shared/types'

export function App() {
  const loadPersistedState = useAppStore((s) => s.loadPersistedState)
  const workspaces = useAppStore((s) => s.workspaces)
  const sessions = useAppStore((s) => s.sessions)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const repairSessionConsistency = useAppStore((s) => s.repairSessionConsistency)
  useProcessStatus()
  useAgentResponses()
  const { toasts, dismissToast, navigateToSession } = useIdleNotifications()
  useAutomations()

  const showAutomationRunsPanel = useAppStore((s) => s.showAutomationRunsPanel)
  const closeAutomationRunsPanel = useAppStore((s) => s.closeAutomationRunsPanel)
  const showDiffPanel = useAppStore((s) => s.showDiffPanel)
  const toggleDiffPanel = useAppStore((s) => s.toggleDiffPanel)
  const diffSelectedFile = useAppStore((s) => s.diffSelectedFile)
  const setDiffSelectedFile = useAppStore((s) => s.setDiffSelectedFile)
  const maestroMode = useAppStore((s) => s.maestroMode)
  const toggleMaestroMode = useAppStore((s) => s.toggleMaestroMode)
  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const panelColor = activeWorkspace?.color ?? '#2a2a3e'
  const tree = activeWorkspace ? getActiveTree(activeWorkspace) : null
  const prewarmedRootsRef = useRef<Set<string>>(new Set())
  const [diffStat, setDiffStat] = useState<{ added: number; removed: number } | null>(null)

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
      const state = useAppStore.getState()
      const targetSessionId = state.maestroMode
        ? state.maestroFocusedSessionId
        : state.activeSessionId
      if (targetSessionId) {
        window.electronAPI.killTerminal(targetSessionId)
        state.deleteSession(targetSessionId)
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
    repairSessionConsistency()
  }, [workspaces, sessions, activeWorkspaceId, activeSessionId, repairSessionConsistency])

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

  // Diff stat polling
  useEffect(() => {
    if (!tree?.rootDir) {
      setDiffStat(null)
      return
    }
    const fetchDiff = () => {
      window.electronAPI.getGitDiffStat(tree.rootDir).then(setDiffStat)
    }
    fetchDiff()
    const interval = setInterval(fetchDiff, 5000)
    return () => clearInterval(interval)
  }, [tree?.rootDir])

  // Global maestro toggle — must live at App level since Sidebar handler is guarded
  useEffect(() => {
    const handleMaestroToggle = (e: KeyboardEvent) => {
      const binding = getBinding('toggle-maestro', useAppStore.getState().settings.keybindingOverrides)
      if (binding && matchesKeybinding(e, binding)) {
        e.preventDefault()
        toggleMaestroMode()
      }
    }
    window.addEventListener('keydown', handleMaestroToggle, true)
    return () => window.removeEventListener('keydown', handleMaestroToggle, true)
  }, [toggleMaestroMode])

  const txtColor = textColor(panelColor)
  const diff = diffColors(panelColor)

  return (
    <div
      className="h-screen flex flex-col text-white overflow-hidden transition-colors duration-300"
      style={{ backgroundColor: panelColor }}
    >
      {/* Header */}
      <div
        className="h-11 flex items-center justify-center shrink-0 relative"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="text-xs font-semibold tracking-widest uppercase" style={{ color: txtColor, opacity: 0.5 }}>
          Orchestra
        </span>
        {/* Diff stat - top right */}
        {diffStat && (diffStat.added > 0 || diffStat.removed > 0) && (
          <button
            onClick={toggleDiffPanel}
            title="Toggle diff panel (⌘⇧D)"
            className="absolute right-3 flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 rounded-md hover:brightness-110 active:brightness-95 transition-all cursor-pointer"
            style={{
              backgroundColor: showDiffPanel ? `${txtColor}25` : `${txtColor}12`,
              border: `1px solid ${showDiffPanel ? `${txtColor}40` : `${txtColor}20`}`,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
          >
            <span style={{ color: diff.added }}>+{diffStat.added}</span>
            <span style={{ color: diff.removed }}>-{diffStat.removed}</span>
          </button>
        )}
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div className="contents" style={maestroMode ? { display: 'none' } : undefined}>
          <Sidebar />
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex flex-1 overflow-hidden">
              {diffSelectedFile ? (
                <DiffView file={diffSelectedFile} onClose={() => setDiffSelectedFile(null)} />
              ) : (
                <TerminalArea />
              )}
              {showDiffPanel && <DiffPanel onClose={toggleDiffPanel} />}
              {showAutomationRunsPanel && <AutomationRunsPanel onClose={closeAutomationRunsPanel} />}
            </div>
            <NavBar />
          </div>
        </div>
        {maestroMode && <MaestroMode />}
      </div>
      <ToastContainer
        notifications={toasts}
        onDismiss={dismissToast}
        onNavigate={navigateToSession}
      />
      {import.meta.env.DEV && <AutomationDebugOverlay />}
    </div>
  )
}
