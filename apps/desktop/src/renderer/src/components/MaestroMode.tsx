import { useMemo, useEffect, useCallback } from 'react'
import { useAppStore } from '../store/app-store'
import { MaestroPane } from './MaestroPane'
import { darkenColor } from './TerminalArea'
import { matchesKeybinding, getBinding } from '../keybindings'
import { textColor } from '../utils/color'
import type { TerminalSession } from '../../../shared/types'

function getGridColumns(count: number): number {
  if (count <= 1) return 1
  if (count <= 2) return 2
  if (count === 3) return 3
  if (count <= 4) return 2
  if (count <= 9) return 3
  return 4
}

function getFontSize(count: number): number {
  if (count <= 4) return 14
  return 12
}

export function MaestroMode() {
  const workspaces = useAppStore((s) => s.workspaces)
  const sessions = useAppStore((s) => s.sessions)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const maestroFocusedSessionId = useAppStore((s) => s.maestroFocusedSessionId)
  const toggleMaestroMode = useAppStore((s) => s.toggleMaestroMode)
  const setMaestroFocusedSession = useAppStore((s) => s.setMaestroFocusedSession)
  const cycleMaestroFocus = useAppStore((s) => s.cycleMaestroFocus)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const runAction = useAppStore((s) => s.runAction)
  const settings = useAppStore((s) => s.settings)

  const workspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const wsColor = workspace?.color ?? '#2a2a3e'
  const termBg = workspace ? darkenColor(workspace.color) : '#1a1a2e'
  const txtColor = textColor(wsColor)

  // Derive agent sessions
  const agentSessions = useMemo(() => {
    if (!workspace) return []
    const allSessionIds = workspace.trees.flatMap(tree => tree.sessionIds)
    return allSessionIds
      .map(id => sessions[id])
      .filter((s): s is TerminalSession => Boolean(s) && (s.processStatus === 'claude' || s.processStatus === 'codex'))
  }, [workspace, sessions])

  // Auto-fix focused session if current one is gone
  useEffect(() => {
    if (agentSessions.length === 0) {
      if (maestroFocusedSessionId) setMaestroFocusedSession(null)
      return
    }
    if (!maestroFocusedSessionId || !agentSessions.find(s => s.id === maestroFocusedSessionId)) {
      setMaestroFocusedSession(agentSessions[0].id)
    }
  }, [agentSessions, maestroFocusedSessionId])

  // Sorted workspaces for cycling
  const sortedWorkspaces = useMemo(() => {
    return Object.values(workspaces).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }, [workspaces])

  const customActions = workspace?.customActions ?? []

  // Keydown handler
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const bind = (id: string) => getBinding(id, settings.keybindingOverrides)

    // Escape: exit maestro mode (only if no dialogs open)
    if (e.key === 'Escape') {
      const hasDialog = document.querySelector('[role="dialog"]') || document.querySelector('.fixed.inset-0')
      if (!hasDialog) {
        e.preventDefault()
        toggleMaestroMode()
        return
      }
    }

    // Focus cycling: Cmd+Up/Down, Ctrl+J/K
    if (matchesKeybinding(e, bind('cycle-sessions-up')) || matchesKeybinding(e, bind('vim-session-up'))) {
      e.preventDefault()
      cycleMaestroFocus('prev')
      return
    }
    if (matchesKeybinding(e, bind('cycle-sessions-down')) || matchesKeybinding(e, bind('vim-session-down'))) {
      e.preventDefault()
      cycleMaestroFocus('next')
      return
    }

    // Workspace cycling: Cmd+Left/Right
    if (matchesKeybinding(e, bind('cycle-workspaces-left')) || matchesKeybinding(e, bind('cycle-workspaces-right'))) {
      if (sortedWorkspaces.length > 1) {
        const currentIdx = sortedWorkspaces.findIndex(ws => ws.id === activeWorkspaceId)
        if (currentIdx !== -1) {
          const goLeft = matchesKeybinding(e, bind('cycle-workspaces-left'))
          const nextIdx = goLeft
            ? (currentIdx - 1 + sortedWorkspaces.length) % sortedWorkspaces.length
            : (currentIdx + 1) % sortedWorkspaces.length
          e.preventDefault()
          setActiveWorkspace(sortedWorkspaces[nextIdx].id)
          return
        }
      }
    }

    // Direct workspace switch: Cmd+Shift+1..9
    if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1
      if (idx < sortedWorkspaces.length) {
        e.preventDefault()
        setActiveWorkspace(sortedWorkspaces[idx].id)
        return
      }
    }

    // Custom action keybindings (e.g. Cmd+N for Claude, Cmd+O for Codex)
    for (const action of customActions) {
      if (!action.keybinding) continue
      if (matchesKeybinding(e, action.keybinding)) {
        e.preventDefault()
        if (action.runInBackground && action.actionType !== 'claude' && action.actionType !== 'codex') {
          return // Background CLI actions not supported from Maestro Mode
        }
        if (activeWorkspaceId) runAction(activeWorkspaceId, action)
        return
      }
    }
  }, [
    settings.keybindingOverrides, toggleMaestroMode, cycleMaestroFocus,
    sortedWorkspaces, activeWorkspaceId, setActiveWorkspace,
    customActions, runAction
  ])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [handleKeyDown])

  const cols = getGridColumns(agentSessions.length)
  const fontSize = getFontSize(agentSessions.length)

  // Empty state
  if (agentSessions.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center rounded-xl" style={{ backgroundColor: termBg }}>
        <div className="w-full h-3 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <p className="text-lg" style={{ color: `${txtColor}66` }}>No active agents</p>
          <p className="text-xs" style={{ color: `${txtColor}44` }}>Press Esc to exit Maestro Mode</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col rounded-xl overflow-hidden" style={{ backgroundColor: termBg }}>
      <div
        className="h-3 w-full shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />
      <div
        className="flex-1 grid p-1 gap-[2px] min-h-0"
        style={{
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridAutoRows: '1fr'
        }}
      >
        {agentSessions.map(session => (
          <MaestroPane
            key={session.id}
            session={session}
            termBg={termBg}
            wsColor={wsColor}
            isFocused={session.id === maestroFocusedSessionId}
            fontSize={fontSize}
            onFocus={() => setMaestroFocusedSession(session.id)}
          />
        ))}
      </div>
    </div>
  )
}
