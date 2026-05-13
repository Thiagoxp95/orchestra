import { useState, useEffect } from 'react'
import { NavBar } from './components/NavBar'
import { Sidebar } from './components/Sidebar'
import { TerminalArea } from './components/TerminalArea'
import { DiffPanel } from './components/DiffPanel'
import { DiffView } from './components/DiffView'
import { UsagePanel } from './components/UsagePanel'
import { useProcessStatus } from './hooks/useProcessStatus'
import { useAgentResponses } from './hooks/useAgentResponses'
import { useAppStore, getActiveTree } from './store/app-store'
import { textColor, diffColors } from './utils/color'
import { ToastContainer } from './components/Toast'
import { VoiceIntroToast } from './components/VoiceIntroToast'
import { VoiceSetupWizard } from './components/VoiceSetupWizard'
import { useIdleNotifications } from './hooks/useIdleNotifications'
import { AutomationRunsPanel } from './components/AutomationRunsPanel'
import { useAutomations } from './hooks/useAutomations'
import { useWebhooks } from './hooks/useWebhooks'
import { useVoice } from './hooks/useVoice'
import { WebhookToastContainer } from './components/WebhookToast'
import { AutomationDebugOverlay } from './components/AutomationDebugOverlay'
import { MaestroMode } from './components/MaestroMode'
import { IssueBoard } from './components/IssueBoard'
import { matchesKeybinding, getBinding } from './keybindings'
import type { PersistedData } from '../../shared/types'
import { DEFAULT_VOICE_SETTINGS, normalizeVoiceWakeWord } from '../../shared/types'

/**
 * Top-level mount of the voice setup wizard, driven by the global
 * `voiceWizardOpen` store flag so the sidebar reminder card (and any other
 * surface) can request the wizard without owning its own copy.
 */
function GlobalVoiceWizardMount() {
  const open = useAppStore((s) => s.voiceWizardOpen)
  const setOpen = useAppStore((s) => s.setVoiceWizardOpen)
  const setVoiceSetupStatus = useAppStore((s) => s.setVoiceSetupStatus)
  const setVoiceSetupAttempted = useAppStore((s) => s.setVoiceSetupAttempted)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const light = activeWorkspace ? !isDark(activeWorkspace.color) : true

  useEffect(() => {
    if (open) setVoiceSetupAttempted(true)
  }, [open, setVoiceSetupAttempted])

  if (!open) return null
  return (
    <VoiceSetupWizard
      open={open}
      light={light}
      onClose={() => setOpen(false)}
      onReady={() => {
        setOpen(false)
        const voice = settings.voice ?? { ...(settings.voice ?? {}) }
        updateSettings({
          ...settings,
          voice: { ...(settings.voice ?? DEFAULT_VOICE_SETTINGS), wakeWord: normalizeVoiceWakeWord(settings.voice?.wakeWord), enabled: true },
        })
        void voice
        window.electronAPI.voiceCheckSetup().then(setVoiceSetupStatus).catch(() => {})
      }}
    />
  )
}

function isDark(hex: string): boolean {
  const m = hex.replace('#', '')
  if (m.length !== 6) return true
  const r = parseInt(m.slice(0, 2), 16)
  const g = parseInt(m.slice(2, 4), 16)
  const b = parseInt(m.slice(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 < 128
}

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
  useVoice()
  const { webhookToasts, dismissWebhookToast, toggleWebhookToastExpand } = useWebhooks()

  const showAutomationRunsPanel = useAppStore((s) => s.showAutomationRunsPanel)
  const closeAutomationRunsPanel = useAppStore((s) => s.closeAutomationRunsPanel)
  const showDiffPanel = useAppStore((s) => s.showDiffPanel)
  const toggleDiffPanel = useAppStore((s) => s.toggleDiffPanel)
  const diffSelectedFile = useAppStore((s) => s.diffSelectedFile)
  const setDiffSelectedFile = useAppStore((s) => s.setDiffSelectedFile)
  const showUsagePanel = useAppStore((s) => s.showUsagePanel)
  const toggleUsagePanel = useAppStore((s) => s.toggleUsagePanel)
  const maestroMode = useAppStore((s) => s.maestroMode)
  const toggleMaestroMode = useAppStore((s) => s.toggleMaestroMode)
  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const panelColor = activeWorkspace?.color ?? '#2a2a3e'
  const tree = activeWorkspace ? getActiveTree(activeWorkspace) : null
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

  // Voice setup card bootstrap: hydrate persisted flags, fetch current
  // status, and subscribe to live progress events. Independent from the
  // wizard so the sidebar reminder works without ever opening Settings.
  useEffect(() => {
    const store = useAppStore.getState()
    window.electronAPI.voiceGetSetupAttempted().then((v) => {
      if (v) useAppStore.setState({ voiceSetupAttempted: true })
    }).catch(() => {})
    window.electronAPI.voiceGetSetupCardDismissed().then((v) => {
      if (v) useAppStore.setState({ voiceSetupCardDismissed: true })
    }).catch(() => {})
    window.electronAPI.voiceCheckSetup().then((status) => {
      useAppStore.getState().setVoiceSetupStatus(status)
    }).catch(() => {})
    void store // satisfy linter — kept for clarity that we touch the store

    const unsub = window.electronAPI.onVoiceSetupProgress((event) => {
      const current = useAppStore.getState().voiceSetupStatus
      useAppStore.getState().setVoiceSetupStatus({
        stage: event.stage,
        message: event.message,
        progress: event.progress,
        canRetry: current?.canRetry ?? false,
        canInstallPython: current?.canInstallPython ?? false,
      })
    })
    return () => { unsub() }
  }, [])

  useEffect(() => {
    const unsub = window.electronAPI.onNormalizedAgentState((status) => {
      const state = useAppStore.getState()
      const session = state.sessions[status.sessionId]
      if (!session) return
      // Drop hook events that mismatch a session that's *known* to be running
      // a different agent — the codex notify hook is global and fires for any
      // nested codex invocation (including codex spawned as a tool from
      // inside a Claude session), so events arrive tagged with the parent
      // Orchestra session id and would otherwise pollute the store with stale
      // codex state for a working Claude.
      //
      // Critically, do *not* drop when processStatus is 'terminal' or
      // unknown: that's the brief window during a fresh codex spawn between
      // process detection and the 'process-change' IPC reaching the renderer,
      // and the rollout watcher's first emission lands in that gap. Dropping
      // it leaves the sidebar at idle while codex is actively working.
      const proc = session.processStatus
      if ((proc === 'claude' || proc === 'codex') && proc !== status.agent) return
      // When state goes to working, clear any stale needs-input flag — the
      // two are mutually exclusive and a working agent has by definition
      // consumed whatever input it was waiting on. Without this, an idle
      // toast that landed before working ARRIVAL leaves the yellow dot
      // stuck on the sidebar while the spinner is also showing.
      if (status.state === 'working') {
        state.clearSessionNeedsUserInput(status.sessionId)
      }
      state.setNormalizedAgentState(status)
    })
    return () => { unsub() }
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
    if (!tree?.rootDir) return
    window.electronAPI.prewarmTerminal({ cwd: tree.rootDir })
  }, [tree?.rootDir])

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
      const state = useAppStore.getState()
      const kb = state.settings.keybindingOverrides
      const binding = getBinding('toggle-maestro', kb)
      if (binding && matchesKeybinding(e, binding)) {
        e.preventDefault()
        toggleMaestroMode()
        return
      }

      // Cmd+Shift+Left/Right: cycle workspace, preserve current view mode
      if (state.maestroMode) return // MaestroMode handles its own cycling
      const maestroLeft = getBinding('cycle-workspaces-maestro-left', kb)
      const maestroRight = getBinding('cycle-workspaces-maestro-right', kb)
      if ((maestroLeft && matchesKeybinding(e, maestroLeft)) || (maestroRight && matchesKeybinding(e, maestroRight))) {
        const sorted = Object.values(state.workspaces).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
        if (sorted.length > 1) {
          const currentIdx = sorted.findIndex((ws) => ws.id === state.activeWorkspaceId)
          if (currentIdx !== -1) {
            const goLeft = maestroLeft ? matchesKeybinding(e, maestroLeft) : false
            const nextIdx = goLeft
              ? (currentIdx - 1 + sorted.length) % sorted.length
              : (currentIdx + 1) % sorted.length
            e.preventDefault()
            state.setActiveWorkspace(sorted[nextIdx].id)
          }
        }
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
        className="h-11 flex items-center justify-center shrink-0 relative overflow-hidden"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {import.meta.env.DEV && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: `repeating-linear-gradient(
                -45deg,
                transparent,
                transparent 8px,
                rgba(234, 179, 8, 0.08) 8px,
                rgba(234, 179, 8, 0.08) 16px
              )`,
            }}
          />
        )}
        <span className="text-xs font-semibold tracking-widest uppercase relative flex items-center gap-2" style={{ color: txtColor, opacity: 0.5 }}>
          {import.meta.env.DEV ? '🚧 Orchestra — WIP 🚧' : 'Orchestra'}
          {maestroMode && activeWorkspace && (
            <>
              <span style={{ opacity: 0.4 }}>/</span>
              <span
                className="inline-flex items-center gap-1.5"
                style={{ opacity: 1, color: txtColor }}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: activeWorkspace.color }}
                />
                {activeWorkspace.name}
              </span>
            </>
          )}
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
              ) : activeWorkspace?.viewMode === 'board' ? (
                <IssueBoard
                  workspaceId={activeWorkspace.id}
                  linearConfig={activeWorkspace.linearConfig}
                  wsColor={panelColor}
                />
              ) : (
                <TerminalArea />
              )}
              {showDiffPanel && <DiffPanel onClose={toggleDiffPanel} />}
              {showUsagePanel && <UsagePanel onClose={toggleUsagePanel} />}
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
      <VoiceIntroToast />
      <GlobalVoiceWizardMount />

      {import.meta.env.DEV && (
        <WebhookToastContainer
          toasts={webhookToasts}
          onDismiss={dismissWebhookToast}
          onToggleExpand={toggleWebhookToastExpand}
        />
      )}
      {import.meta.env.DEV && <AutomationDebugOverlay />}
    </div>
  )
}
