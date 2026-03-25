import { useMemo, useEffect, useCallback, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { MaestroPane } from './MaestroPane'
import { darkenColor } from './TerminalArea'
import { matchesKeybinding, getBinding } from '../keybindings'
import { textColor } from '../utils/color'
import type { TerminalSession } from '../../../shared/types'

function getGridColumns(count: number): number {
  if (count <= 1) return 1
  if (count <= 4) return 2
  if (count <= 9) return 3
  return 4
}

function getFontSize(count: number): number {
  if (count <= 2) return 14
  if (count <= 4) return 13
  if (count <= 6) return 12
  if (count <= 9) return 11
  return 10
}

export function MaestroMode() {
  const workspaces = useAppStore((s) => s.workspaces)
  const sessions = useAppStore((s) => s.sessions)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const maestroFocusedSessionId = useAppStore((s) => s.maestroFocusedSessionId)
  const toggleMaestroMode = useAppStore((s) => s.toggleMaestroMode)
  const setMaestroFocusedSession = useAppStore((s) => s.setMaestroFocusedSession)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const runAction = useAppStore((s) => s.runAction)
  const settings = useAppStore((s) => s.settings)

  const workspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const wsColor = workspace?.color ?? '#2a2a3e'
  const termBg = workspace ? darkenColor(workspace.color) : '#1a1a2e'
  const txtColor = textColor(wsColor)

  // Poll git branches for workspace trees
  const [treeBranches, setTreeBranches] = useState<Record<number, string>>({})
  useEffect(() => {
    if (!workspace) return
    const fetchBranches = () => {
      workspace.trees.forEach((tree, idx) => {
        window.electronAPI.getGitBranch(tree.rootDir).then((branch) => {
          if (branch) {
            setTreeBranches((prev) => {
              if (prev[idx] === branch) return prev
              return { ...prev, [idx]: branch }
            })
          }
        })
      })
    }
    fetchBranches()
    const interval = setInterval(fetchBranches, 10_000)
    return () => clearInterval(interval)
  }, [workspace])

  // Derive agent sessions with their tree info
  const agentSessions = useMemo(() => {
    if (!workspace) return [] as { session: TerminalSession; treeLabel: string; branchName?: string }[]
    const result: { session: TerminalSession; treeLabel: string; branchName?: string }[] = []
    for (let i = 0; i < workspace.trees.length; i++) {
      const tree = workspace.trees[i]
      const treeLabel = tree.rootDir.split('/').pop() ?? tree.rootDir
      const branchName = treeBranches[i]
      for (const id of tree.sessionIds) {
        const s = sessions[id]
        if (s && (s.processStatus === 'claude' || s.processStatus === 'codex')) {
          result.push({ session: s, treeLabel, branchName })
        }
      }
    }
    return result
  }, [workspace, sessions, treeBranches])

  // Auto-fix focused session if current one is gone
  useEffect(() => {
    if (agentSessions.length === 0) {
      if (maestroFocusedSessionId) setMaestroFocusedSession(null)
      return
    }
    if (!maestroFocusedSessionId || !agentSessions.find(s => s.session.id === maestroFocusedSessionId)) {
      setMaestroFocusedSession(agentSessions[0].session.id)
    }
  }, [agentSessions, maestroFocusedSessionId])

  // Sorted workspaces for cycling
  const sortedWorkspaces = useMemo(() => {
    return Object.values(workspaces).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }, [workspaces])

  const customActions = workspace?.customActions ?? []

  // Grid-aware pane navigation
  const navigateGrid = useCallback((direction: 'up' | 'down' | 'left' | 'right') => {
    if (agentSessions.length === 0) return
    const currentIdx = maestroFocusedSessionId
      ? agentSessions.findIndex(s => s.session.id === maestroFocusedSessionId)
      : -1
    if (currentIdx === -1) {
      setMaestroFocusedSession(agentSessions[0].session.id)
      return
    }
    const gridCols = getGridColumns(agentSessions.length)
    const total = agentSessions.length
    let targetIdx: number
    switch (direction) {
      case 'left':
        targetIdx = (currentIdx - 1 + total) % total
        break
      case 'right':
        targetIdx = (currentIdx + 1) % total
        break
      case 'up': {
        targetIdx = currentIdx - gridCols
        if (targetIdx < 0) {
          // Wrap to last row in this column
          const col = currentIdx % gridCols
          const lastRowStart = Math.floor((total - 1) / gridCols) * gridCols
          targetIdx = lastRowStart + col
          if (targetIdx >= total) targetIdx -= gridCols
        }
        break
      }
      case 'down': {
        targetIdx = currentIdx + gridCols
        if (targetIdx >= total) {
          // Wrap to first row in this column
          targetIdx = currentIdx % gridCols
        }
        break
      }
    }
    if (targetIdx >= 0 && targetIdx < total) {
      setMaestroFocusedSession(agentSessions[targetIdx].session.id)
    }
  }, [agentSessions, maestroFocusedSessionId, setMaestroFocusedSession])

  // Keydown handler
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Escape: exit maestro mode (only if no dialogs open)
    if (e.key === 'Escape') {
      const hasDialog = document.querySelector('[role="dialog"]') || document.querySelector('.fixed.inset-0')
      if (!hasDialog) {
        e.preventDefault()
        toggleMaestroMode()
        return
      }
    }

    // Grid navigation: Cmd+Arrow keys
    if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateGrid('up'); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateGrid('down'); return }
      if (e.key === 'ArrowLeft') { e.preventDefault(); navigateGrid('left'); return }
      if (e.key === 'ArrowRight') { e.preventDefault(); navigateGrid('right'); return }
    }

    // Vim grid navigation: Ctrl+H/J/K/L
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (e.key === 'k') { e.preventDefault(); navigateGrid('up'); return }
      if (e.key === 'j') { e.preventDefault(); navigateGrid('down'); return }
      if (e.key === 'h') { e.preventDefault(); navigateGrid('left'); return }
      if (e.key === 'l') { e.preventDefault(); navigateGrid('right'); return }
    }

    // Cycle workspaces left/right — stay in maestro mode (preserve current view)
    const kb = settings.keybindingOverrides
    const bind = (id: string) => getBinding(id, kb)
    if (matchesKeybinding(e, bind('cycle-workspaces-maestro-left')) || matchesKeybinding(e, bind('cycle-workspaces-maestro-right'))) {
      if (sortedWorkspaces.length > 1) {
        const currentIdx = sortedWorkspaces.findIndex((ws) => ws.id === activeWorkspaceId)
        if (currentIdx !== -1) {
          const goLeft = matchesKeybinding(e, bind('cycle-workspaces-maestro-left'))
          const nextIdx = goLeft
            ? (currentIdx - 1 + sortedWorkspaces.length) % sortedWorkspaces.length
            : (currentIdx + 1) % sortedWorkspaces.length
          e.preventDefault()
          setActiveWorkspace(sortedWorkspaces[nextIdx].id)
          return
        }
      }
    }

    // Direct workspace switch: Cmd+Shift+1..9 — exit maestro mode on switch
    if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1
      if (idx < sortedWorkspaces.length) {
        e.preventDefault()
        setActiveWorkspace(sortedWorkspaces[idx].id)
        toggleMaestroMode()
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
    toggleMaestroMode, navigateGrid,
    sortedWorkspaces, activeWorkspaceId, setActiveWorkspace,
    customActions, runAction, settings.keybindingOverrides
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
        {agentSessions.map(({ session, treeLabel, branchName }) => (
          <MaestroPane
            key={session.id}
            session={session}
            treeLabel={treeLabel}
            branchName={branchName}
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
