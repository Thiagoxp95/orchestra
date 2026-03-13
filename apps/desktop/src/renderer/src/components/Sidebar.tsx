import { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'
import { SessionItem } from './SessionItem'
import { DynamicIcon } from './DynamicIcon'
import { SettingsDialog } from './SettingsDialog'
import { KeybindingsDialog } from './KeybindingsDialog'
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog'
import { Settings01Icon } from 'hugeicons-react'
import { Tooltip } from './Tooltip'
import { textColor, isLightColor } from '../utils/color'
import { matchesKeybinding, getBinding } from '../keybindings'
import { formatCountdown } from '../../../shared/schedule-utils'
import type { ClaudeWatcherDebugState, CodexWatcherDebugState } from '../../../shared/types'

const AGENT_DEBUG_STORAGE_KEY = 'orchestra-agent-debug-overlay'

function formatDebugAgo(timestamp: number | null | undefined): string {
  if (!timestamp) return '-'

  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (deltaSeconds < 1) return 'now'
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`

  const minutes = Math.round(deltaSeconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.round(minutes / 60)
  return `${hours}h ago`
}

function formatDebugPath(filePath: string | null | undefined): string {
  if (!filePath) return '-'
  const parts = filePath.split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

function BranchIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <line x1="4" y1="2" x2="4" y2="10" />
      <circle cx="4" cy="12" r="2" />
      <circle cx="12" cy="4" r="2" />
      <path d="M12 6c0 3-2 4-6 4" />
    </svg>
  )
}

function FolderIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M2 4c0-.6.4-1 1-1h3.6l1.4 2H13c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V4z" />
    </svg>
  )
}

function DestructionFailedDialog({ error, onDismiss, onForce, wsColor, txtColor }: { error: string; onDismiss: () => void; onForce: () => void; wsColor: string; txtColor: string }) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onDismiss() }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onDismiss])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onDismiss}>
      <div className="rounded-xl p-6 w-[380px] shadow-2xl border border-white/10" style={{ backgroundColor: wsColor }} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-2" style={{ color: txtColor }}>Destruction Script Failed</h2>
        <p className="text-sm mb-3 opacity-70" style={{ color: txtColor }}>A script failed during worktree destruction:</p>
        <pre className="text-xs bg-black/15 rounded-md px-3 py-2 mb-4 overflow-auto max-h-[120px] whitespace-pre-wrap" style={{ color: txtColor }}>{error}</pre>
        <div className="flex justify-end gap-2">
          <button
            onClick={onDismiss}
            className="px-4 py-2 text-sm rounded-md hover:bg-white/5 transition-colors opacity-70 hover:opacity-100"
            style={{ color: txtColor }}
          >
            Cancel
          </button>
          <button
            onClick={onForce}
            className="px-4 py-2 text-sm bg-white/10 rounded-md hover:bg-white/20 transition-colors"
            style={{ color: txtColor }}
          >
            Delete Anyway
          </button>
        </div>
      </div>
    </div>
  )
}

function WorktreeDialog({ onConfirm, onCancel, wsColor, txtColor }: { onConfirm: (branch: string) => void; onCancel: () => void; wsColor: string; txtColor: string }) {
  const [branch, setBranch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (branch.trim()) onConfirm(branch.trim())
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onCancel}>
      <form onSubmit={handleSubmit} className="rounded-xl p-6 w-[340px] shadow-2xl border border-white/10" style={{ backgroundColor: wsColor }} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4" style={{ color: txtColor }}>New Worktree</h2>
        <input
          ref={inputRef}
          type="text"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="Branch name"
          className="w-full bg-black/10 border border-white/10 rounded-md px-3 py-2 text-sm placeholder-gray-500 focus:outline-none focus:border-white/20"
          style={{ color: txtColor }}
        />
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-md hover:bg-white/5 transition-colors opacity-70 hover:opacity-100"
            style={{ color: txtColor }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!branch.trim()}
            className="px-4 py-2 text-sm bg-white/10 rounded-md hover:bg-white/20 transition-colors disabled:opacity-50"
            style={{ color: txtColor }}
          >
            Create
          </button>
        </div>
      </form>
    </div>
  )
}

export function Sidebar() {
  const workspaces = useAppStore((s) => s.workspaces)
  const sessions = useAppStore((s) => s.sessions)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const runAction = useAppStore((s) => s.runAction)
  const toggleDiffPanel = useAppStore((s) => s.toggleDiffPanel)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const deleteAllSessions = useAppStore((s) => s.deleteAllSessions)
  const moveSession = useAppStore((s) => s.moveSession)
  const setActiveSession = useAppStore((s) => s.setActiveSession)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const addWorktree = useAppStore((s) => s.addWorktree)
  const removeWorktree = useAppStore((s) => s.removeWorktree)
  const setDeletingWorktree = useAppStore((s) => s.setDeletingWorktree)
  const deletingWorktrees = useAppStore((s) => s.deletingWorktrees)
  const setActiveTree = useAppStore((s) => s.setActiveTree)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const addCustomAction = useAppStore((s) => s.addCustomAction)
  const updateCustomAction = useAppStore((s) => s.updateCustomAction)
  const deleteCustomAction = useAppStore((s) => s.deleteCustomAction)
  const toggleNotificationSounds = useAppStore((s) => s.toggleNotificationSounds)
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspace)
  const updateWorkspace = useAppStore((s) => s.updateWorkspace)
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const claudeLastResponse = useAppStore((s) => s.claudeLastResponse)
  const claudeWorkState = useAppStore((s) => s.claudeWorkState)
  const codexLastResponse = useAppStore((s) => s.codexLastResponse)
  const codexWorkState = useAppStore((s) => s.codexWorkState)
  const sessionNeedsUserInput = useAppStore((s) => s.sessionNeedsUserInput)
  const automationNextRunAt = useAppStore((s) => s.automationNextRunAt)
  const openAutomationRunsPanel = useAppStore((s) => s.openAutomationRunsPanel)
  const isDev = import.meta.env.DEV

  const sortedWorkspaces = Object.values(workspaces).sort((a, b) => a.createdAt - b.createdAt)
  const workspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const customActions = workspace?.customActions ?? []

  const [treeBranches, setTreeBranches] = useState<Record<string, Record<number, string>>>({})
  const [showWorktreeDialog, setShowWorktreeDialog] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [confirmedSessions, setConfirmedSessions] = useState<Set<string>>(new Set())
  const [listeningPorts, setListeningPorts] = useState<{ port: number; pid: number; sessionId: string }[]>([])
  const [focusMode, setFocusMode] = useState(false)
  const [actionToasts, setActionToasts] = useState<{ id: string; name: string; icon: string; fadingOut: boolean }[]>([])
  const [runningBgActions, setRunningBgActions] = useState<Set<string>>(new Set())
  const [showKeybindings, setShowKeybindings] = useState(false)
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false)
  const [destructionFailure, setDestructionFailure] = useState<{ wsId: string; treeIndex: number; error: string } | null>(null)
  const [showAgentDebug, setShowAgentDebug] = useState(() => {
    try {
      return import.meta.env.DEV && localStorage.getItem(AGENT_DEBUG_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [claudeDebugState, setClaudeDebugState] = useState<Record<string, ClaudeWatcherDebugState>>({})
  const [codexDebugState, setCodexDebugState] = useState<Record<string, CodexWatcherDebugState>>({})


  const allTrees = workspace?.trees ?? []
  const getCodexSessionState = (sessionId: string) => codexWorkState[sessionId] ?? 'idle'
  const getCodexSessionActionState = (sessionId: string) => {
    if (sessionNeedsUserInput[sessionId] === true) return 'waitingUserInput'
    const state = getCodexSessionState(sessionId)
    if (state === 'waitingUserInput' || state === 'waitingApproval') return state
    return null
  }
  const getTreeCodexActionState = (sessionIds: string[]) => {
    let hasApproval = false

    for (const sessionId of sessionIds) {
      const state = getCodexSessionActionState(sessionId)
      if (state === 'waitingUserInput') return 'waitingUserInput'
      if (state === 'waitingApproval') hasApproval = true
    }

    return hasApproval ? 'waitingApproval' : null
  }

  const isSessionWorking = (session: (typeof sessions)[string] | undefined) => {
    if (!session) return false
    if (session.processStatus === 'claude') return claudeWorkState[session.id] === 'working'
    if (session.processStatus === 'codex') return getCodexSessionState(session.id) === 'working'
    return false
  }

  const isTreeCodexWorking = (sessionIds: string[]) => (
    sessionIds.some((sessionId) => {
      const session = sessions[sessionId]
      return session?.processStatus === 'codex' && getCodexSessionState(sessionId) === 'working'
    })
  )

  const getSessionAgentResponse = (session: (typeof sessions)[string]) => {
    const claudeResponse = claudeLastResponse[session.id]
    const codexResponse = codexLastResponse[session.id]

    if (session.processStatus === 'claude') return claudeResponse || codexResponse || undefined
    if (session.processStatus === 'codex') return codexResponse || claudeResponse || undefined
    if (session.actionIcon === '__claude__') return claudeResponse || codexResponse || undefined
    if (session.actionIcon === '__openai__') return codexResponse || claudeResponse || undefined

    return codexResponse || claudeResponse || undefined
  }

  // Sort sessions: active indicators (needs input > needs approval > working) float to top
  const getSessionSortPriority = (session: (typeof sessions)[string]) => {
    const codexState = getCodexSessionState(session.id)
    const needsInput = codexState === 'waitingUserInput' || sessionNeedsUserInput[session.id] === true
    if (needsInput) return 0
    if (codexState === 'waitingApproval') return 1
    if (isSessionWorking(session)) return 2
    return 3
  }

  const sortSessionsByActivity = <T extends (typeof sessions)[string]>(list: T[]) =>
    [...list].sort((a, b) => getSessionSortPriority(a) - getSessionSortPriority(b))

  useEffect(() => {
    if (!isDev) {
      setShowAgentDebug(false)
      return
    }

    try {
      localStorage.setItem(AGENT_DEBUG_STORAGE_KEY, showAgentDebug ? '1' : '0')
    } catch {}
  }, [isDev, showAgentDebug])

  useEffect(() => {
    if (!isDev || !showAgentDebug) return

    let cancelled = false
    const refresh = () => {
      window.electronAPI.getClaudeDebugState().then((entries) => {
        if (cancelled) return
        setClaudeDebugState(Object.fromEntries(entries.map((entry) => [entry.sessionId, entry])))
      }).catch(() => {})
      window.electronAPI.getCodexDebugState().then((entries) => {
        if (cancelled) return
        setCodexDebugState(Object.fromEntries(entries.map((entry) => [entry.sessionId, entry])))
      }).catch(() => {})
    }

    refresh()
    const interval = window.setInterval(refresh, 1000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [isDev, showAgentDebug])

  // Git branch polling for ALL workspaces
  useEffect(() => {
    const fetchBranches = () => {
      for (const ws of sortedWorkspaces) {
        ws.trees.forEach((tree, idx) => {
          window.electronAPI.getGitBranch(tree.rootDir).then((branch) => {
            if (branch) {
              setTreeBranches((prev) => ({
                ...prev,
                [ws.id]: { ...(prev[ws.id] ?? {}), [idx]: branch }
              }))
            }
          })
        })
      }
    }
    fetchBranches()
    const interval = setInterval(fetchBranches, 5000)
    return () => clearInterval(interval)
  }, [sortedWorkspaces.map((w) => w.id + w.trees.length).join(',')])

  // Port scanning
  useEffect(() => {
    const fetchPorts = () => {
      window.electronAPI.getListeningPorts().then(setListeningPorts).catch(() => {})
    }
    fetchPorts()
    const interval = setInterval(fetchPorts, 5000)
    return () => clearInterval(interval)
  }, [])

  // Keybinding listener
  useEffect(() => {
    const kb = settings.keybindingOverrides
    const bind = (id: string) => getBinding(id, kb)

    const handler = (e: KeyboardEvent) => {
      // Skip when Maestro Mode is active — MaestroMode has its own handler
      const { maestroMode } = useAppStore.getState()
      if (maestroMode) return

      if (!activeWorkspaceId) return

      // Determine if focus is in any text-editing context (inputs, textareas, terminal)
      const tag = (e.target as HTMLElement).tagName
      const isTerminal = (e.target as HTMLElement).closest('.xterm')
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      const isEditing = isInput || !!isTerminal

      // --- Global shortcuts: work even when editing/in terminal ---

      // Toggle sidebar
      if (matchesKeybinding(e, bind('toggle-sidebar'))) {
        e.preventDefault(); toggleSidebar(); return
      }

      // Toggle diff panel
      if (matchesKeybinding(e, bind('toggle-diff'))) {
        e.preventDefault(); toggleDiffPanel(); return
      }

      // Cmd+Shift+1..9 to switch workspaces (no conflict with text editing)
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1
        if (idx < sortedWorkspaces.length) {
          e.preventDefault()
          setActiveWorkspace(sortedWorkspaces[idx].id)
          return
        }
      }

      // Cmd+1..9 to switch worktrees (no conflict with text editing)
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1
        if (idx < allTrees.length) {
          e.preventDefault()
          if (workspace && workspace.activeTreeIndex === idx) {
            setFocusMode((prev) => !prev)
          } else {
            setFocusMode(false)
            setActiveTree(activeWorkspaceId, idx)
          }
          return
        }
      }

      // Reorder session up/down
      if (matchesKeybinding(e, bind('reorder-session-up'))) {
        if (activeSessionId) { e.preventDefault(); moveSession(activeSessionId, 'up'); return }
      }
      if (matchesKeybinding(e, bind('reorder-session-down'))) {
        if (activeSessionId) { e.preventDefault(); moveSession(activeSessionId, 'down'); return }
      }

      // Cycle sessions up/down
      if (matchesKeybinding(e, bind('cycle-sessions-up')) || matchesKeybinding(e, bind('cycle-sessions-down'))) {
        if (workspace && activeSessionId) {
          const allSessions: { id: string; treeIdx: number }[] = []
          for (let t = 0; t < allTrees.length; t++) {
            for (const sid of allTrees[t].sessionIds) {
              allSessions.push({ id: sid, treeIdx: t })
            }
          }
          const currentIdx = allSessions.findIndex((s) => s.id === activeSessionId)
          if (currentIdx !== -1 && allSessions.length > 1) {
            const goUp = matchesKeybinding(e, bind('cycle-sessions-up'))
            const nextIdx = goUp
              ? (currentIdx - 1 + allSessions.length) % allSessions.length
              : (currentIdx + 1) % allSessions.length
            const next = allSessions[nextIdx]
            e.preventDefault()
            if (next.treeIdx !== workspace.activeTreeIndex) {
              setActiveTree(activeWorkspaceId, next.treeIdx)
            }
            setActiveSession(next.id)
            return
          }
        }
      }

      // Cycle workspaces left/right (Cmd-based, works everywhere)
      if (matchesKeybinding(e, bind('cycle-workspaces-left')) || matchesKeybinding(e, bind('cycle-workspaces-right'))) {
        if (sortedWorkspaces.length > 1) {
          const currentIdx = sortedWorkspaces.findIndex((ws) => ws.id === activeWorkspaceId)
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

      // Custom actions (work everywhere)
      for (const action of customActions) {
        if (!action.keybinding) continue
        if (matchesKeybinding(e, action.keybinding)) {
          e.preventDefault()
          handleRunAction(action)
          return
        }
      }

      // Cmd+, to open workspace settings
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === ',') {
        e.preventDefault()
        if (workspace) setShowSettings(true)
        return
      }

      // --- Non-global shortcuts: skip when focus is in any text-editing context ---
      if (isEditing) return

      // Ctrl+1..9 to switch sessions within active worktree
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        const activeTreeData = workspace ? allTrees[workspace.activeTreeIndex] : null
        if (activeTreeData) {
          const idx = parseInt(e.key) - 1
          if (idx < activeTreeData.sessionIds.length) {
            e.preventDefault()
            setActiveSession(activeTreeData.sessionIds[idx])
            return
          }
        }
      }

      // Vim-style session cycling
      if (matchesKeybinding(e, bind('vim-session-up')) || matchesKeybinding(e, bind('vim-session-down'))) {
        if (workspace && activeSessionId) {
          const allSessions: { id: string; treeIdx: number }[] = []
          for (let t = 0; t < allTrees.length; t++) {
            for (const sid of allTrees[t].sessionIds) {
              allSessions.push({ id: sid, treeIdx: t })
            }
          }
          const currentIdx = allSessions.findIndex((s) => s.id === activeSessionId)
          if (currentIdx !== -1 && allSessions.length > 1) {
            const goUp = matchesKeybinding(e, bind('vim-session-up'))
            const nextIdx = goUp
              ? (currentIdx - 1 + allSessions.length) % allSessions.length
              : (currentIdx + 1) % allSessions.length
            const next = allSessions[nextIdx]
            e.preventDefault()
            if (next.treeIdx !== workspace.activeTreeIndex) {
              setActiveTree(activeWorkspaceId, next.treeIdx)
            }
            setActiveSession(next.id)
            return
          }
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [customActions, activeWorkspaceId, activeSessionId, runAction, allTrees.length, setActiveTree, setActiveSession, moveSession, workspace, sortedWorkspaces, setActiveWorkspace, settings.keybindingOverrides])

  const handleCreateWorktree = async (branchName: string) => {
    if (!workspace || !activeWorkspaceId) return
    setShowWorktreeDialog(false)
    const mainRoot = workspace.trees[0].rootDir
    const result = await window.electronAPI.createWorktree(mainRoot, branchName, settings.worktreesDir)
    if (result.success && result.path) {
      addWorktree(activeWorkspaceId, result.path)
      // Run actions flagged for worktree creation
      for (const action of customActions) {
        if (action.runOnWorktreeCreation) {
          if (action.runInBackground) {
            runBackgroundAction(action)
          } else {
            runAction(activeWorkspaceId, action)
          }
        }
      }
    } else {
      window.alert(`Failed to create worktree:\n${result.error}`)
    }
  }

  const forceDeleteWorktree = async (wsId: string, treeIndex: number) => {
    const ws = workspaces[wsId]
    if (!ws) return
    const tree = ws.trees[treeIndex]
    if (!tree) return
    const key = `${wsId}:${treeIndex}`

    setDeletingWorktree(key, true)
    try {
      for (const sid of tree.sessionIds) {
        window.electronAPI.killTerminal(sid)
      }
      const mainRoot = ws.trees[0].rootDir
      await window.electronAPI.removeWorktree(mainRoot, tree.rootDir)
      removeWorktree(wsId, treeIndex)
    } catch (err: any) {
      window.alert(`Failed to delete worktree:\n${err?.message ?? err}`)
    } finally {
      setDeletingWorktree(key, false)
    }
  }

  const handleDeleteWorktree = async (wsId: string, treeIndex: number, e: React.MouseEvent) => {
    e.stopPropagation()
    const ws = workspaces[wsId]
    if (!ws || ws.trees.length <= 1) return
    const tree = ws.trees[treeIndex]
    const key = `${wsId}:${treeIndex}`
    if (deletingWorktrees.has(key)) return // Already deleting

    setDeletingWorktree(key, true)
    try {
      // Run destruction actions first — if any fail, prompt user
      const destructionActions = ws.customActions.filter((a) => a.runOnWorktreeDestruction)
      for (const action of destructionActions) {
        const cwd = tree.rootDir
        const result = await window.electronAPI.runBackgroundCommand(cwd, action.command)
        if (!result.success) {
          setDeletingWorktree(key, false)
          setDestructionFailure({ wsId, treeIndex, error: result.error ?? `"${action.command}" failed` })
          return
        }
      }

      // Kill all sessions in this worktree
      for (const sid of tree.sessionIds) {
        window.electronAPI.killTerminal(sid)
      }

      // Remove the git worktree (use first tree as main repo)
      const mainRoot = ws.trees[0].rootDir
      await window.electronAPI.removeWorktree(mainRoot, tree.rootDir)

      // Remove from store
      removeWorktree(wsId, treeIndex)
    } catch (err: any) {
      window.alert(`Failed to delete worktree:\n${err?.message ?? err}`)
    } finally {
      setDeletingWorktree(key, false)
    }
  }

  const handleDeleteWorkspace = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const ws = workspaces[id]
    if (ws) {
      for (const tree of ws.trees) {
        for (const sid of tree.sessionIds) {
          window.electronAPI.killTerminal(sid)
        }
      }
    }
    deleteWorkspace(id)
  }

  const wsColor = workspace?.color ?? '#2a2a3e'
  const txtColor = textColor(wsColor)

  const borderColor = isLightColor(wsColor) ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.05)'

  const confirmSession = (sessionId: string) => {
    setConfirmedSessions((prev) => new Set(prev).add(sessionId))
    setTimeout(() => {
      setConfirmedSessions((prev) => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }, 1500)
  }

  const showActionToast = (action: { id: string; name: string; icon: string }) => {
    const toastId = `${action.id}-${Date.now()}`
    setActionToasts((prev) => [...prev, { id: toastId, name: action.name, icon: action.icon, fadingOut: false }])
    setTimeout(() => {
      setActionToasts((prev) => prev.map((t) => t.id === toastId ? { ...t, fadingOut: true } : t))
      setTimeout(() => {
        setActionToasts((prev) => prev.filter((t) => t.id !== toastId))
      }, 300)
    }, 2000)
  }

  const runBackgroundAction = async (action: typeof customActions[number]) => {
    const aType = action.actionType ?? 'cli'
    if (aType === 'claude' || aType === 'codex') {
      // Claude/Codex can't run headlessly — convert to interactive
      runAction(activeWorkspaceId!, { ...action, runInBackground: false })
      return
    }
    if (runningBgActions.has(action.id)) return
    setRunningBgActions((prev) => new Set(prev).add(action.id))
    const tree = workspace ? workspace.trees[workspace.activeTreeIndex] ?? workspace.trees[0] : null
    const cwd = tree?.rootDir ?? '~'
    const result = await window.electronAPI.runBackgroundCommand(cwd, action.command)
    setRunningBgActions((prev) => {
      const next = new Set(prev)
      next.delete(action.id)
      return next
    })
    if (result.success) {
      showActionToast(action)
    }
  }

  const handleRunAction = (action: typeof customActions[number]) => {
    if (!activeWorkspaceId) return
    if (action.runInBackground) {
      runBackgroundAction(action)
      return
    }
    const sessionId = runAction(activeWorkspaceId, action)
    if (action.focusOnCreation === false && sessionId) {
      confirmSession(sessionId)
    }
  }

  const handleDeleteSession = (sessionId: string) => {
    window.electronAPI.killTerminal(sessionId)
    deleteSession(sessionId)
  }

  const handleDeleteAllSessions = (workspaceId: string, treeIndex: number, sessionIds: string[]) => {
    for (const sid of sessionIds) {
      window.electronAPI.killTerminal(sid)
    }
    deleteAllSessions(workspaceId, treeIndex)
  }

  const defaultEmojis = ['📁', '📂', '🗂️', '📦', '🔧', '⚡', '🚀', '💼', '🎯']
  const getEmoji = (ws: typeof sortedWorkspaces[number], idx: number) =>
    ws.emoji || defaultEmojis[idx % defaultEmojis.length]

  const collapsed = sidebarCollapsed

  return (
    <div className={`${collapsed ? 'w-20' : 'w-96'} relative flex flex-col transition-all duration-300 shrink-0 border-r`} style={{ borderColor: `${txtColor}15`, backgroundColor: wsColor }}>
      {/* Toggle button */}
      <div
        className={`h-6 flex items-center ${collapsed ? 'justify-center' : 'justify-end px-3'} shrink-0`}
      >
        <button
          onClick={toggleSidebar}
          className="opacity-40 hover:opacity-100 transition-opacity"
          style={{ color: txtColor }}
          title={collapsed ? 'Expand sidebar (⌘B)' : 'Collapse sidebar (⌘B)'}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            {collapsed ? (
              <>
                <rect x="1" y="2" width="14" height="12" rx="2" />
                <line x1="5" y1="2" x2="5" y2="14" />
                <polyline points="8,6 10,8 8,10" />
              </>
            ) : (
              <>
                <rect x="1" y="2" width="14" height="12" rx="2" />
                <line x1="5" y1="2" x2="5" y2="14" />
                <polyline points="10,6 8,8 10,10" />
              </>
            )}
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {sortedWorkspaces.map((ws, wsIdx) => {
          const isActiveWs = ws.id === activeWorkspaceId
          const wsBranches = treeBranches[ws.id] ?? {}

          return (
            <div key={ws.id} style={{ opacity: isActiveWs ? 1 : 0.5 }} className="transition-opacity duration-200">
              {/* Workspace header */}
              {collapsed ? (
                <Tooltip text={ws.name}>
                  <div
                    className="group flex items-center justify-center px-1 py-1.5 rounded-md cursor-pointer hover:opacity-80 transition-opacity"
                    style={{ color: txtColor }}
                    onClick={() => setActiveWorkspace(ws.id)}
                  >
                    <span className="shrink-0 text-sm">{getEmoji(ws, wsIdx)}</span>
                  </div>
                </Tooltip>
              ) : (
                <div
                  className="group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer hover:opacity-80 transition-opacity"
                  style={{ color: txtColor }}
                  onClick={() => setActiveWorkspace(ws.id)}
                >
                  <span className="shrink-0 text-sm">{getEmoji(ws, wsIdx)}</span>
                  <span className="text-sm font-medium truncate flex-1">{ws.name}</span>
                  {isActiveWs && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowSettings(true) }}
                      className="opacity-50 hover:!opacity-100 transition-opacity"
                      style={{ color: txtColor }}
                    >
                      <Settings01Icon size={14} />
                    </button>
                  )}
                  <span
                    onClick={(e) => handleDeleteWorkspace(ws.id, e)}
                    className={`cursor-pointer text-xs transition-opacity ${isActiveWs ? 'opacity-50 hover:!opacity-100' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'}`}
                    style={{ color: txtColor }}
                  >
                    ×
                  </span>
                </div>
              )}

              {/* Expanded content for active workspace */}
              {isActiveWs && !collapsed && (
                <div className="space-y-0.5">
                  {/* New worktree button - only show if workspace has git */}
                  {wsBranches[0] && (
                    <button
                      onClick={() => setShowWorktreeDialog(true)}
                      className="flex items-center justify-center gap-1.5 w-full py-1 rounded-lg text-xs transition-colors hover:opacity-80"
                      style={{ color: txtColor, border: `1.5px dashed ${txtColor}44` }}
                    >
                      <span>+</span>
                      <span>New worktree</span>
                    </button>
                  )}

                  {ws.trees.map((tree, treeIdx) => {
                    const branch = wsBranches[treeIdx]
                    const treeSessions = tree.sessionIds.map((id) => sessions[id]).filter(Boolean)
                    const isActiveTree = ws.activeTreeIndex === treeIdx
                    const worktreeKey = `${ws.id}:${treeIdx}`
                    const isDeleting = deletingWorktrees.has(worktreeKey)
                    const treeHasWorkingCodex = isTreeCodexWorking(tree.sessionIds)
                    const treeCodexActionState = getTreeCodexActionState(tree.sessionIds)
                    const treeActionColor = treeCodexActionState === 'waitingUserInput'
                      ? '#f6c453'
                      : treeCodexActionState === 'waitingApproval'
                        ? '#60a5fa'
                        : null

                    return (
                      <div key={treeIdx} style={{ opacity: isDeleting ? 0.3 : isActiveTree ? 1 : 0.45, pointerEvents: isDeleting ? 'none' : undefined }} className="transition-opacity duration-200">
                        {/* Branch header */}
                        <div
                          className="group/tree flex items-center gap-1.5 px-2 py-1 text-xs rounded-md cursor-pointer hover:opacity-80"
                          style={{ color: txtColor }}
                          onClick={() => {
                            if (isDeleting) return
                            if (isActiveTree) {
                              setFocusMode((prev) => !prev)
                            } else {
                              setFocusMode(false)
                              setActiveTree(ws.id, treeIdx)
                            }
                          }}
                        >
                          {treeIdx === 0 ? (
                            <>
                              <FolderIcon color={txtColor} />
                              <span className="truncate" title={tree.rootDir}>
                                {isDeleting ? 'Deleting...' : tree.rootDir.split('/').pop()}
                              </span>
                              {branch && (
                                <>
                                  <BranchIcon color={txtColor} />
                                  <span className="truncate opacity-60" title={branch}>
                                    {branch}
                                  </span>
                                </>
                              )}
                            </>
                          ) : (
                            <>
                              <BranchIcon color={txtColor} />
                              <span className="truncate" title={branch ?? tree.rootDir}>
                                {isDeleting ? 'Deleting...' : (branch ?? tree.rootDir.split('/').pop())}
                              </span>
                            </>
                          )}
                          {treeHasWorkingCodex && !isDeleting ? (
                            <span className="shrink-0 animate-spin" title="Codex is working">
                              <DynamicIcon name="__openai__" size={12} color={txtColor} />
                            </span>
                          ) : treeActionColor && !isDeleting ? (
                            <span
                              className="shrink-0 w-2 h-2 rounded-full"
                              style={{ backgroundColor: treeActionColor }}
                              title={treeCodexActionState === 'waitingUserInput' ? 'A session is waiting for your reply' : 'Codex is waiting for approval'}
                            />
                          ) : isActiveTree && !isDeleting ? (
                            <span
                              className="shrink-0 w-1.5 h-1.5 rounded-full"
                              style={{ backgroundColor: txtColor }}
                            />
                          ) : null}
                          <span className="flex-1" />
                          {treeSessions.length > 1 && !isDeleting && (
                            <span
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDeleteAllSessions(ws.id, treeIdx, tree.sessionIds)
                              }}
                              className="shrink-0 cursor-pointer opacity-0 group-hover/tree:opacity-50 hover:!opacity-100 transition-opacity"
                              style={{ color: txtColor }}
                              title="Kill all sessions"
                            >
                              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                <line x1="2" y1="4" x2="14" y2="4" />
                                <line x1="5" y1="2" x2="11" y2="2" />
                                <rect x="3" y="4" width="10" height="10" rx="1" strokeWidth="1.5" />
                                <line x1="6" y1="7" x2="6" y2="11" strokeWidth="1.5" />
                                <line x1="10" y1="7" x2="10" y2="11" strokeWidth="1.5" />
                              </svg>
                            </span>
                          )}
                          {ws.trees.length > 1 && !isDeleting && (
                            <span
                              onClick={(e) => handleDeleteWorktree(ws.id, treeIdx, e)}
                              className="shrink-0 cursor-pointer opacity-0 group-hover/tree:opacity-50 hover:!opacity-100 transition-opacity"
                              style={{ color: txtColor }}
                              title="Delete worktree"
                            >
                              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                <line x1="4" y1="4" x2="12" y2="12" />
                                <line x1="12" y1="4" x2="4" y2="12" />
                              </svg>
                            </span>
                          )}
                          {ws.trees.length > 1 && treeIdx < 9 && !isDeleting && (
                            <kbd
                              className="shrink-0 text-[10px] font-mono leading-none px-1 py-0.5 rounded border"
                              style={{ color: txtColor, borderColor: `${txtColor}33`, opacity: 0.5 }}
                            >
                              ⌘{treeIdx + 1}
                            </kbd>
                          )}
                        </div>
                        {/* Indented sessions */}
                        {(!focusMode || isActiveTree) && (
                          <div className="space-y-0.5">
                            {sortSessionsByActivity(treeSessions).map((session, sessionIdx) => {
                                const isWorking = isSessionWorking(session)
                                const agentResponse = getSessionAgentResponse(session)
                                const codexState = getCodexSessionState(session.id)
                                const needsApproval = codexState === 'waitingApproval'
                                const needsUserInput = codexState === 'waitingUserInput' || sessionNeedsUserInput[session.id] === true
                                const statusLabel = needsApproval ? 'Approve' : needsUserInput ? 'Reply' : undefined
                                const claudeDebug = claudeDebugState[session.id]
                                const codexDebug = codexDebugState[session.id]
                                const shouldShowClaudeDebug = isDev && showAgentDebug && (
                                  session.processStatus === 'claude' ||
                                  session.actionIcon === '__claude__' ||
                                  Boolean(claudeDebug) ||
                                  claudeWorkState[session.id] === 'working' ||
                                  Boolean(claudeLastResponse[session.id])
                                )
                                const shouldShowCodexDebug = showAgentDebug && (
                                  session.processStatus === 'codex' ||
                                  session.actionIcon === '__openai__' ||
                                  Boolean(codexDebug) ||
                                  (codexWorkState[session.id] ?? 'idle') !== 'idle' ||
                                  Boolean(codexLastResponse[session.id])
                                )
                                const displayIcon = session.processStatus === 'claude' ? '__claude__'
                                  : session.processStatus === 'codex' ? '__openai__'
                                  : (session.actionIcon === '__claude__' || session.actionIcon === '__openai__') ? '__terminal__'
                                  : (session.actionIcon || '__terminal__')
                                return (
                              <div key={session.id}>
                              <SessionItem
                                label={session.label}
                                icon={displayIcon}
                                isActive={session.id === activeSessionId}
                                wsColor={wsColor}
                                confirmed={confirmedSessions.has(session.id)}
                                kbdHint={isActiveTree && sessionIdx < 9 ? `⌃${sessionIdx + 1}` : undefined}
                                isWorking={isWorking}
                                needsApproval={needsApproval}
                                needsUserInput={needsUserInput}
                                statusLabel={statusLabel}
                                agentResponse={agentResponse}
                                onClick={() => setActiveSession(session.id)}
                                onDelete={() => handleDeleteSession(session.id)}
                              />
                              {shouldShowClaudeDebug && (
                                <div
                                  className="ml-8 mt-1 rounded-md border px-2 py-1.5 text-[10px] font-mono leading-4 space-y-0.5"
                                  style={{
                                    color: txtColor,
                                    borderColor: `${txtColor}26`,
                                    backgroundColor: isLightColor(wsColor) ? 'rgba(0,0,0,0.045)' : 'rgba(255,255,255,0.045)',
                                  }}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-semibold tracking-wide">CLAUDE DEBUG</span>
                                    <span className="opacity-60">{session.id.slice(0, 8)}</span>
                                  </div>
                                  <div className="opacity-80">
                                    ui `proc={session.processStatus}` `spinner={isWorking ? 'working' : 'idle'}` `store={claudeWorkState[session.id] ?? 'idle'}`
                                  </div>
                                  <div className="opacity-80">
                                    watcher `state={claudeDebug?.lastWorkState ?? '-'}` `src={claudeDebug?.lastWorkStateSource ?? '-'}` `bind={claudeDebug?.bindingSource ?? '-'}`
                                  </div>
                                  <div className="opacity-80">
                                    hook `last={claudeDebug?.lastHookEvent ?? '-'} @ {formatDebugAgo(claudeDebug?.lastHookEventAt)}` `pending={claudeDebug?.pendingHookEvent ?? '-'}`
                                  </div>
                                  <div className="opacity-80">
                                    title `state={claudeDebug?.lastTitleState ?? '-'} @ {formatDebugAgo(claudeDebug?.lastTitleStateAt)}` `jsonl={claudeDebug?.lastJsonlActivity ?? '-'} @ {formatDebugAgo(claudeDebug?.lastJsonlActivityAt)}`
                                  </div>
                                  <div className="opacity-80">
                                    file `jsonl={formatDebugPath(claudeDebug?.jsonlPath)}` `pid={claudeDebug?.claudePid ?? '-'}` `siblings={claudeDebug?.hasSiblingSessionInProjectDir ? 'yes' : 'no'}` `retries={claudeDebug?.lsofRetries ?? '-'}`
                                  </div>
                                  {claudeDebug?.lastResponsePreview && (
                                    <div
                                      className="opacity-70 truncate"
                                      title={claudeDebug.lastResponsePreview}
                                    >
                                      reply `{claudeDebug.lastResponsePreview}`
                                    </div>
                                  )}
                                  {!claudeDebug && (
                                    <div className="opacity-60">
                                      watcher `not-attached`
                                    </div>
                                  )}
                                </div>
                              )}
                              {shouldShowCodexDebug && (
                                <div
                                  className="ml-8 mt-1 rounded-md border px-2 py-1.5 text-[10px] font-mono leading-4 space-y-0.5"
                                  style={{
                                    color: txtColor,
                                    borderColor: `${txtColor}26`,
                                    backgroundColor: isLightColor(wsColor) ? 'rgba(0,0,0,0.045)' : 'rgba(255,255,255,0.045)',
                                  }}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-semibold tracking-wide">CODEX DEBUG</span>
                                    <span className="opacity-60">{session.id.slice(0, 8)}</span>
                                  </div>
                                  <div className="opacity-80">
                                    ui `proc={session.processStatus}` `spinner={isWorking ? 'working' : 'idle'}` `store={codexWorkState[session.id] ?? 'idle'}`
                                  </div>
                                  <div className="opacity-80">
                                    watcher `state={codexDebug?.lastWorkState ?? '-'}` `pending={codexDebug?.pendingHookEvent ?? '-'}`
                                  </div>
                                  <div className="opacity-80">
                                    file `log={formatDebugPath(codexDebug?.logPath)}` `exists={codexDebug?.logExists ? 'yes' : 'no'}` `pid={codexDebug?.codexPid ?? '-'}`
                                  </div>
                                  {codexDebug?.lastResponsePreview && (
                                    <div
                                      className="opacity-70 truncate"
                                      title={codexDebug.lastResponsePreview}
                                    >
                                      reply `{codexDebug.lastResponsePreview}`
                                    </div>
                                  )}
                                  {!codexDebug && (
                                    <div className="opacity-60">
                                      watcher `not-attached`
                                    </div>
                                  )}
                                </div>
                              )}
                              </div>
                                )
                              })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Collapsed content for active workspace - icons only */}
              {isActiveWs && collapsed && (
                <div className="space-y-0.5">
                  {ws.trees.map((tree, treeIdx) => {
                    const treeSessions = tree.sessionIds.map((id) => sessions[id]).filter(Boolean)
                    const isActiveTree = ws.activeTreeIndex === treeIdx
                    const branch = wsBranches[treeIdx]
                    const treeHasWorkingCodex = isTreeCodexWorking(tree.sessionIds)
                    const treeCodexActionState = getTreeCodexActionState(tree.sessionIds)
                    const treeActionColor = treeCodexActionState === 'waitingUserInput'
                      ? '#f6c453'
                      : treeCodexActionState === 'waitingApproval'
                        ? '#60a5fa'
                        : null

                    return (
                      <div key={treeIdx} style={{ opacity: isActiveTree ? 1 : 0.45 }} className="transition-opacity duration-200">
                        {treeIdx > 0 && (
                          <div className="mx-2 my-1 border-t" style={{ borderColor }} />
                        )}
                        <Tooltip text={branch ?? tree.rootDir.split('/').pop() ?? ''}>
                          <div
                            className="flex items-center justify-center py-1 rounded-md cursor-pointer hover:opacity-80"
                            style={{ color: txtColor }}
                            onClick={() => {
                              if (isActiveTree) setFocusMode((prev) => !prev)
                              else { setFocusMode(false); setActiveTree(ws.id, treeIdx) }
                            }}
                          >
                            <BranchIcon color={txtColor} />
                            {treeHasWorkingCodex ? (
                              <span className="shrink-0 ml-1 animate-spin" title="Codex is working">
                                <DynamicIcon name="__openai__" size={10} color={txtColor} />
                              </span>
                            ) : treeActionColor ? (
                              <span
                                className="shrink-0 ml-1 w-2 h-2 rounded-full"
                                style={{ backgroundColor: treeActionColor }}
                                title={treeCodexActionState === 'waitingUserInput' ? 'A session is waiting for your reply' : 'Codex is waiting for approval'}
                              />
                            ) : isActiveTree ? (
                              <span className="shrink-0 w-1.5 h-1.5 rounded-full ml-1" style={{ backgroundColor: txtColor }} />
                            ) : null}
                          </div>
                        </Tooltip>
                        {(!focusMode || isActiveTree) && sortSessionsByActivity(treeSessions).map((session) => {
                          const isActiveSess = session.id === activeSessionId
                          const activeBg = isLightColor(wsColor) ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)'
                          const hoverBg = isLightColor(wsColor) ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)'
                          const isWorking = isSessionWorking(session)
                          const codexState = getCodexSessionState(session.id)
                          const needsApproval = codexState === 'waitingApproval'
                          const needsUserInput = codexState === 'waitingUserInput' || sessionNeedsUserInput[session.id] === true
                          const actionColor = needsUserInput ? '#f6c453' : needsApproval ? '#60a5fa' : null
                          const isAgent = session.processStatus === 'claude' || session.processStatus === 'codex'
                          const collapsedIcon = session.processStatus === 'claude' ? '__claude__'
                            : session.processStatus === 'codex' ? '__openai__'
                            : (session.actionIcon === '__claude__' || session.actionIcon === '__openai__') ? '__terminal__'
                            : (session.actionIcon || '__terminal__')
                          return (
                            <Tooltip
                              key={session.id}
                              text={needsApproval ? `${session.label} — Approval needed` : needsUserInput ? `${session.label} — Reply needed` : session.label}
                            >
                              <div
                                className="flex items-center justify-center py-1.5 rounded-md cursor-pointer transition-colors"
                                style={{
                                  backgroundColor: isActiveSess ? activeBg : undefined,
                                  animation: isWorking && isAgent && !((needsUserInput || needsApproval) && !isActiveSess)
                                      ? 'shimmer-icon 2s infinite linear'
                                      : undefined,
                                }}
                                onClick={() => setActiveSession(session.id)}
                                onMouseEnter={(e) => { if (!isActiveSess) e.currentTarget.style.backgroundColor = hoverBg }}
                                onMouseLeave={(e) => { if (!isActiveSess) e.currentTarget.style.backgroundColor = '' }}
                              >
                                <span
                                  className={`relative ${
                                    (needsUserInput || needsApproval) && !isActiveSess
                                      ? 'animate-session-attention'
                                      : isWorking && isAgent
                                        ? 'animate-spin'
                                        : ''
                                  }`}
                                >
                                  <DynamicIcon name={collapsedIcon} size={16} color={txtColor} />
                                  {actionColor && (
                                    <span
                                      className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full"
                                      style={{ backgroundColor: actionColor, boxShadow: `0 0 0 2px ${wsColor}` }}
                                    />
                                  )}
                                </span>
                              </div>
                            </Tooltip>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

      </div>

      {/* Automations */}
      {(() => {
        const automationActions = customActions.filter((a) => a.schedule && a.automationEnabled !== false)
        if (automationActions.length === 0 || collapsed) return null
        const hoverBg = isLightColor(wsColor) ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)'
        return (
          <div className="px-3 py-2 shrink-0 border-t" style={{ borderColor }}>
            <span className="text-[10px] font-medium" style={{ color: txtColor, opacity: 0.7 }}>
              Automations
            </span>
            <div className="mt-1 space-y-0.5">
              {automationActions.map((action) => {
                const nextRun = automationNextRunAt[action.id]
                const countdown = nextRun ? formatCountdown(nextRun) : null
                return (
                  <div
                    key={action.id}
                    className="flex items-center gap-2 px-1.5 py-1 rounded-md cursor-pointer transition-colors"
                    onClick={() => openAutomationRunsPanel(action.id)}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = hoverBg }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '' }}
                  >
                    <DynamicIcon name={action.icon} size={14} color={txtColor} />
                    <span className="text-[11px] flex-1 truncate" style={{ color: txtColor }}>
                      {action.name}
                    </span>
                    {countdown && (
                      <span className="text-[10px] font-mono shrink-0" style={{ color: txtColor, opacity: 0.4 }}>
                        {countdown}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* Ports */}
      {listeningPorts.length > 0 && !collapsed && (
        <div
          className="px-3 py-2 shrink-0 border-t relative group/ports"
          style={{ borderColor }}
        >
          <span className="text-[10px] font-medium" style={{ color: txtColor }}>Ports</span>
          <div
            className="mt-1 space-y-1 overflow-hidden transition-[max-height] duration-300 ease-in-out max-h-[40px] group-hover/ports:max-h-[400px]"
          >
            {listeningPorts.map((p) => {
              const session = sessions[p.sessionId]
              const ownerWs = session ? workspaces[session.workspaceId] : null
              const ownerColor = ownerWs?.color ?? wsColor
              const ownerEmoji = ownerWs ? getEmoji(ownerWs, sortedWorkspaces.indexOf(ownerWs)) : null
              const handleClick = () => {
                if (!session) return
                if (ownerWs && ownerWs.id !== activeWorkspaceId) setActiveWorkspace(ownerWs.id)
                setActiveSession(p.sessionId)
              }
              const hoverBg = isLightColor(wsColor) ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)'
              return (
                <div
                  key={p.port}
                  className="flex items-center gap-1.5 px-1.5 py-1 rounded-md cursor-pointer transition-colors"
                  onClick={handleClick}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = hoverBg }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '' }}
                >
                  {ownerEmoji && <span className="text-[10px] shrink-0">{ownerEmoji}</span>}
                  <span
                    className="text-[11px] font-mono font-medium px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: txtColor, color: ownerColor }}
                  >
                    {p.port}
                  </span>
                  {session && (
                    <span className="text-[10px] truncate ml-auto" style={{ color: txtColor, opacity: 0.5 }}>
                      {session.label}
                    </span>
                  )}
                  <button
                    className="shrink-0 opacity-0 group-hover/ports:opacity-50 hover:!opacity-100 transition-opacity ml-1"
                    style={{ color: txtColor }}
                    title={`Kill process on port ${p.port} (PID ${p.pid})`}
                    onClick={(e) => {
                      e.stopPropagation()
                      window.electronAPI.killPort(p.pid).then(() => {
                        setListeningPorts((prev) => prev.filter((x) => x.port !== p.port))
                      })
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <line x1="4" y1="4" x2="12" y2="12" />
                      <line x1="12" y1="4" x2="4" y2="12" />
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
          {/* Fade gradient - hidden when expanded */}
          <div
            className="absolute bottom-0 left-0 right-0 h-5 pointer-events-none transition-opacity duration-300 opacity-100 group-hover/ports:opacity-0"
            style={{ background: `linear-gradient(transparent, ${wsColor})` }}
          />
        </div>
      )}

      {/* Notification sounds toggle */}
      {!collapsed && (
        <div className="px-3 py-2 shrink-0 border-t" style={{ borderColor }}>
          <div className="flex items-center justify-between">
            <span className="text-[10px]" style={{ color: txtColor }}>Sounds</span>
            <button
              onClick={toggleNotificationSounds}
              className="relative w-7 h-4 rounded-full transition-colors duration-200"
              style={{
                backgroundColor: settings.notificationSoundsMuted
                  ? `${txtColor}20`
                  : txtColor,
              }}
              title={settings.notificationSoundsMuted ? 'Enable notification sounds' : 'Mute notification sounds'}
            >
              <span
                className="absolute top-0.5 left-0.5 w-3 h-3 rounded-full transition-transform duration-200"
                style={{
                  backgroundColor: settings.notificationSoundsMuted ? `${txtColor}60` : wsColor,
                  transform: settings.notificationSoundsMuted ? 'translateX(0)' : 'translateX(12px)',
                }}
              />
            </button>
          </div>
        </div>
      )}

      {isDev && !collapsed && (
        <div className="px-3 py-2 shrink-0 border-t" style={{ borderColor }}>
          <button
            onClick={() => setShowAgentDebug((prev) => !prev)}
            className={`w-full flex items-center justify-between px-2 py-1.5 rounded-md text-[10px] transition-colors ${isLightColor(wsColor) ? 'hover:bg-black/5' : 'hover:bg-white/5'}`}
            style={{ color: txtColor }}
            title="Show live agent watcher debug state in the session list"
          >
            <span className="font-medium">Agent Debug Overlay</span>
            <span className="opacity-60">{showAgentDebug ? 'On' : 'Off'}</span>
          </button>
        </div>
      )}

      {/* Keyboard shortcuts button */}
      {!collapsed && (
        <div className="px-3 py-2 shrink-0 border-t" style={{ borderColor }}>
          <button
            onClick={() => setShowKeybindings(true)}
            className={`w-full flex items-center justify-between px-2 py-1.5 rounded-md text-[10px] transition-colors ${isLightColor(wsColor) ? 'hover:bg-black/5' : 'hover:bg-white/5'}`}
            style={{ color: txtColor }}
          >
            <span className="font-medium">Keyboard Shortcuts</span>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="opacity-50">
              <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      )}

      {/* New workspace button */}
      <div className={`px-2 py-2 shrink-0 ${collapsed ? 'flex justify-center' : ''}`}>
        <button
          onClick={() => setShowCreateWorkspace(true)}
          className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded-lg text-xs transition-colors hover:opacity-80"
          style={{
            color: txtColor,
            border: `1.5px dashed ${txtColor}44`,
          }}
          title={collapsed ? 'New workspace' : undefined}
        >
          <span>+</span>
          {!collapsed && <span>New workspace</span>}
        </button>
      </div>

      {/* Dialogs */}
      {showKeybindings && (
        <KeybindingsDialog
          wsColor={wsColor}
          overrides={settings.keybindingOverrides ?? {}}
          customActions={customActions}
          onSave={(overrides) => {
            updateSettings({ ...settings, keybindingOverrides: Object.keys(overrides).length > 0 ? overrides : undefined })
          }}
          onClose={() => setShowKeybindings(false)}
        />
      )}
      {showWorktreeDialog && (
        <WorktreeDialog
          onConfirm={handleCreateWorktree}
          onCancel={() => setShowWorktreeDialog(false)}
          wsColor={wsColor}
          txtColor={txtColor}
        />
      )}
      {showSettings && workspace && (
        <SettingsDialog
          settings={settings}
          customActions={workspace.customActions ?? []}
          wsColor={wsColor}
          repositorySettingsEnabled={workspace.repositorySettings?.enabled === true}
          notificationSound={workspace.notificationSound}
          questionNotificationSound={workspace.questionNotificationSound}
          onSaveSettings={updateSettings}
          onSaveRepositorySettings={async (sharedSettings) => {
            const rootDir = workspace.trees[0]?.rootDir ?? workspace.trees[workspace.activeTreeIndex]?.rootDir
            if (!rootDir || !activeWorkspaceId) {
              return { success: false, error: 'Missing workspace root directory' }
            }
            const result = await window.electronAPI.saveRepositoryWorkspaceSettings(rootDir, sharedSettings)
            if (result.success) {
              updateWorkspace(activeWorkspaceId, {
                repositorySettings: { enabled: Boolean(sharedSettings) }
              })
            }
            return result
          }}
          onUpdateAction={(id, updates) => { if (activeWorkspaceId) updateCustomAction(activeWorkspaceId, id, updates) }}
          onDeleteAction={(id) => { if (activeWorkspaceId) deleteCustomAction(activeWorkspaceId, id) }}
          onAddAction={(action) => { if (activeWorkspaceId) addCustomAction(activeWorkspaceId, action) }}
          onUpdateWorkspaceColor={(color) => { if (activeWorkspaceId) updateWorkspace(activeWorkspaceId, { color }) }}
          onUpdateNotificationSound={(sound) => { if (activeWorkspaceId) updateWorkspace(activeWorkspaceId, { notificationSound: sound }) }}
          onUpdateQuestionNotificationSound={(sound) => { if (activeWorkspaceId) updateWorkspace(activeWorkspaceId, { questionNotificationSound: sound }) }}
          workspaceRootDir={workspace.trees[0]?.rootDir ?? null}
          existingTreePaths={workspace.trees.map(t => t.rootDir)}
          worktrees={workspace.trees.map((t, i) => ({
            rootDir: t.rootDir,
            label: i === 0 ? 'Base' : t.rootDir.split('/').pop() ?? `Tree ${i}`,
          }))}
          onImportWorktrees={(paths) => {
            if (!activeWorkspaceId) return
            for (const p of paths) {
              addWorktree(activeWorkspaceId, p)
            }
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {destructionFailure && (
        <DestructionFailedDialog
          error={destructionFailure.error}
          wsColor={wsColor}
          txtColor={txtColor}
          onDismiss={() => setDestructionFailure(null)}
          onForce={() => {
            const { wsId, treeIndex } = destructionFailure
            setDestructionFailure(null)
            forceDeleteWorktree(wsId, treeIndex)
          }}
        />
      )}
      {showCreateWorkspace && (
        <CreateWorkspaceDialog
          onConfirm={async (name, color, rootDir) => {
            const repositorySettings = await window.electronAPI.getRepositoryWorkspaceSettings(rootDir)
            const workspaceId = createWorkspace(name, color, rootDir, repositorySettings)
            const ws = useAppStore.getState().workspaces[workspaceId]
            const tree = ws?.trees[ws.activeTreeIndex]
            if (tree?.sessionIds[0]) {
              window.electronAPI.createTerminal(tree.sessionIds[0], { cwd: rootDir })
            }
            setShowCreateWorkspace(false)
          }}
          onCancel={() => setShowCreateWorkspace(false)}
        />
      )}

      {/* Background action toasts */}
      {actionToasts.length > 0 && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none items-center">
          {actionToasts.map((t) => (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-center gap-2.5 px-4 py-2.5 rounded-xl shadow-lg
                transition-all duration-300
                ${t.fadingOut ? 'opacity-0 -translate-y-4' : 'opacity-100 translate-y-0 animate-toast-in'}`}
              style={{
                backgroundColor: wsColor,
                border: `1px solid ${isLightColor(wsColor) ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.1)'}`,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke={txtColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <polyline points="4 9 8 13 14 5" />
              </svg>
              <span className="text-sm font-medium" style={{ color: txtColor }}>{t.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
