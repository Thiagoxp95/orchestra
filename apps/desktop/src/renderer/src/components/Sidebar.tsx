import { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'
import { SessionItem } from './SessionItem'
import { DynamicIcon } from './DynamicIcon'
import { SettingsDialog } from './SettingsDialog'
import { Settings01Icon } from 'hugeicons-react'
import { Kbd } from './Kbd'
import { Tooltip } from './Tooltip'
import { textColor, isLightColor } from '../utils/color'

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

function WorktreeDialog({ onConfirm, onCancel, wsColor, txtColor }: { onConfirm: (branch: string) => void; onCancel: () => void; wsColor: string; txtColor: string }) {
  const [branch, setBranch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (branch.trim()) onConfirm(branch.trim())
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <form onSubmit={handleSubmit} className="rounded-xl p-6 w-[340px] shadow-2xl border border-white/10" style={{ backgroundColor: wsColor }}>
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
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspace)
  const updateWorkspace = useAppStore((s) => s.updateWorkspace)
  const claudeLastResponse = useAppStore((s) => s.claudeLastResponse)
  const claudeWorkState = useAppStore((s) => s.claudeWorkState)
  const codexLastResponse = useAppStore((s) => s.codexLastResponse)
  const codexWorkState = useAppStore((s) => s.codexWorkState)
  const sessionNeedsUserInput = useAppStore((s) => s.sessionNeedsUserInput)
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


  const allTrees = workspace?.trees ?? []

  const isSessionWorking = (session: (typeof sessions)[string] | undefined) => {
    if (!session) return false
    if (session.processStatus === 'claude') return claudeWorkState[session.id] === 'working'
    if (session.processStatus === 'codex') return codexWorkState[session.id] === 'working'
    return false
  }

  const isTreeCodexWorking = (sessionIds: string[]) => (
    sessionIds.some((sessionId) => {
      const session = sessions[sessionId]
      return session?.processStatus === 'codex' && codexWorkState[sessionId] === 'working'
    })
  )

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
    const handler = (e: KeyboardEvent) => {
      if (!activeWorkspaceId) return

      // Allow Cmd+Arrow shortcuts even when terminal (xterm textarea) is focused
      const tag = (e.target as HTMLElement).tagName
      const isTerminal = (e.target as HTMLElement).closest('.xterm')
      if (!isTerminal && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) return

      // Cmd+Left/Right to cycle through workspaces
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (sortedWorkspaces.length > 1) {
          const currentIdx = sortedWorkspaces.findIndex((ws) => ws.id === activeWorkspaceId)
          if (currentIdx !== -1) {
            const nextIdx = e.key === 'ArrowLeft'
              ? (currentIdx - 1 + sortedWorkspaces.length) % sortedWorkspaces.length
              : (currentIdx + 1) % sortedWorkspaces.length
            e.preventDefault()
            setActiveWorkspace(sortedWorkspaces[nextIdx].id)
            return
          }
        }
      }

      // Cmd+B to toggle sidebar
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        toggleSidebar()
        return
      }

      // Cmd+Shift+D to toggle diff panel
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        toggleDiffPanel()
        return
      }

      // Cmd+Shift+1..9 to switch workspaces
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1
        if (idx < sortedWorkspaces.length) {
          e.preventDefault()
          setActiveWorkspace(sortedWorkspaces[idx].id)
          return
        }
      }

      // Cmd+1..9 to switch worktrees (or toggle focus mode if already active)
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

      // Cmd+Shift+Up/Down to reorder active session within its tree
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (activeSessionId) {
          e.preventDefault()
          moveSession(activeSessionId, e.key === 'ArrowUp' ? 'up' : 'down')
          return
        }
      }

      // Cmd+Up/Down to cycle through all sessions across all trees in workspace
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (workspace && activeSessionId) {
          // Build flat list of all sessions with their tree index
          const allSessions: { id: string; treeIdx: number }[] = []
          for (let t = 0; t < allTrees.length; t++) {
            for (const sid of allTrees[t].sessionIds) {
              allSessions.push({ id: sid, treeIdx: t })
            }
          }
          const currentIdx = allSessions.findIndex((s) => s.id === activeSessionId)
          if (currentIdx !== -1 && allSessions.length > 1) {
            const nextIdx = e.key === 'ArrowUp'
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

      for (const action of customActions) {
        if (!action.keybinding) continue
        const parts = action.keybinding.split('+')
        const key = parts[parts.length - 1]
        const needCmd = parts.includes('Cmd')
        const needCtrl = parts.includes('Ctrl')
        const needAlt = parts.includes('Alt')
        const needShift = parts.includes('Shift')

        const keyMatch = e.key.length === 1
          ? e.key.toUpperCase() === key
          : e.key === key

        if (
          keyMatch &&
          e.metaKey === needCmd &&
          e.ctrlKey === needCtrl &&
          e.altKey === needAlt &&
          e.shiftKey === needShift
        ) {
          e.preventDefault()
          handleRunAction(action)
          return
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [customActions, activeWorkspaceId, activeSessionId, runAction, allTrees.length, setActiveTree, setActiveSession, moveSession, workspace, sortedWorkspaces, setActiveWorkspace])

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
          runAction(activeWorkspaceId, action)
        }
      }
    } else {
      window.alert(`Failed to create worktree:\n${result.error}`)
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
      // Run destruction actions first
      const destructionActions = ws.customActions.filter((a) => a.runOnWorktreeDestruction)
      for (const action of destructionActions) {
        const cwd = tree.rootDir
        await window.electronAPI.runBackgroundCommand(cwd, action.command)
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

  const handleRunAction = (action: typeof customActions[number]) => {
    if (!activeWorkspaceId) return
    const sessionId = runAction(activeWorkspaceId, action)
    if (action.focusOnCreation === false && sessionId) {
      confirmSession(sessionId)
    }
  }

  const handleDeleteSession = (sessionId: string) => {
    window.electronAPI.killTerminal(sessionId)
    deleteSession(sessionId)
  }

  const defaultEmojis = ['📁', '📂', '🗂️', '📦', '🔧', '⚡', '🚀', '💼', '🎯']
  const getEmoji = (ws: typeof sortedWorkspaces[number], idx: number) =>
    ws.emoji || defaultEmojis[idx % defaultEmojis.length]

  const collapsed = sidebarCollapsed

  return (
    <div className={`${collapsed ? 'w-20' : 'w-96'} relative flex flex-col transition-all duration-300`}>
      {/* Traffic light space + toggle */}
      <div
        className={`h-12 flex items-end ${collapsed ? 'px-1 justify-center' : 'px-3 justify-between'} pb-1 shrink-0`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {!collapsed && (
          <span className="text-xs font-semibold tracking-wide opacity-40" style={{ color: txtColor }}>
            ORCHESTRA
          </span>
        )}
        <button
          onClick={toggleSidebar}
          className="opacity-40 hover:opacity-100 transition-opacity"
          style={{ color: txtColor, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
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
                          ) : isActiveTree && !isDeleting ? (
                            <span
                              className="shrink-0 w-1.5 h-1.5 rounded-full"
                              style={{ backgroundColor: txtColor }}
                            />
                          ) : null}
                          <span className="flex-1" />
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
                            {treeSessions.map((session, sessionIdx) => {
                                const isWorking = isSessionWorking(session)
                                const agentResponse = claudeLastResponse[session.id] || codexLastResponse[session.id] || undefined
                                const needsUserInput = sessionNeedsUserInput[session.id] === true
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
                                needsUserInput={needsUserInput}
                                agentResponse={(displayIcon === '__claude__' || displayIcon === '__openai__') ? agentResponse : undefined}
                                onClick={() => setActiveSession(session.id)}
                                onDelete={() => handleDeleteSession(session.id)}
                              />
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
                            ) : isActiveTree ? (
                              <span className="shrink-0 w-1.5 h-1.5 rounded-full ml-1" style={{ backgroundColor: txtColor }} />
                            ) : null}
                          </div>
                        </Tooltip>
                        {(!focusMode || isActiveTree) && treeSessions.map((session) => {
                          const isActiveSess = session.id === activeSessionId
                          const activeBg = isLightColor(wsColor) ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)'
                          const hoverBg = isLightColor(wsColor) ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)'
                          const isWorking = isSessionWorking(session)
                          const needsUserInput = sessionNeedsUserInput[session.id] === true
                          const isAgent = session.processStatus === 'claude' || session.processStatus === 'codex'
                          const collapsedIcon = session.processStatus === 'claude' ? '__claude__'
                            : session.processStatus === 'codex' ? '__openai__'
                            : (session.actionIcon === '__claude__' || session.actionIcon === '__openai__') ? '__terminal__'
                            : (session.actionIcon || '__terminal__')
                          return (
                            <Tooltip key={session.id} text={session.label}>
                              <div
                                className="flex items-center justify-center py-1.5 rounded-md cursor-pointer transition-colors"
                                style={{
                                  backgroundColor: isActiveSess ? activeBg : undefined,
                                  animation: isWorking && isAgent && !(needsUserInput && !isActiveSess)
                                      ? 'shimmer-icon 2s infinite linear'
                                      : undefined,
                                }}
                                onClick={() => setActiveSession(session.id)}
                                onMouseEnter={(e) => { if (!isActiveSess) e.currentTarget.style.backgroundColor = hoverBg }}
                                onMouseLeave={(e) => { if (!isActiveSess) e.currentTarget.style.backgroundColor = '' }}
                              >
                                <span
                                  className={`relative ${
                                    needsUserInput && !isActiveSess
                                      ? 'animate-session-attention'
                                      : isWorking && isAgent
                                        ? 'animate-spin'
                                        : ''
                                  }`}
                                >
                                  <DynamicIcon name={collapsedIcon} size={16} color={txtColor} />
                                  {needsUserInput && (
                                    <span
                                      className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full"
                                      style={{ backgroundColor: '#f6c453', boxShadow: `0 0 0 2px ${wsColor}` }}
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

      {/* Keyboard hints */}
      {!collapsed && (
        <div className="px-3 py-2 space-y-1 shrink-0 border-t" style={{ borderColor }}>
          <div className="flex items-center justify-between">
            <span className="text-[10px]" style={{ color: txtColor }}>Sessions</span>
            <span className="flex items-center gap-1">
              <Kbd shortcut="Cmd+ArrowUp" color={txtColor} /> <Kbd shortcut="Cmd+ArrowDown" color={txtColor} />
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px]" style={{ color: txtColor }}>Reorder</span>
            <span className="flex items-center gap-1">
              <Kbd shortcut="Cmd+Shift+ArrowUp" color={txtColor} /> <Kbd shortcut="Cmd+Shift+ArrowDown" color={txtColor} />
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px]" style={{ color: txtColor }}>Workspaces</span>
            <span className="flex items-center gap-1">
              <Kbd shortcut="Cmd+ArrowLeft" color={txtColor} /> <Kbd shortcut="Cmd+ArrowRight" color={txtColor} />
            </span>
          </div>
        </div>
      )}

      {/* Dialogs */}
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
          onImportWorktrees={(paths) => {
            if (!activeWorkspaceId) return
            for (const p of paths) {
              addWorktree(activeWorkspaceId, p)
            }
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {isDev && <div className="dev-grid-overlay" style={{ '--dev-color': `${txtColor}18` } as React.CSSProperties} />}
    </div>
  )
}
