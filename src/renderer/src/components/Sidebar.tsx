import { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'
import { SessionItem } from './SessionItem'
import { SettingsDialog } from './SettingsDialog'
import { Settings01Icon } from 'hugeicons-react'
import { textColor, mutedTextColor, isLightColor } from '../utils/color'

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

function WorktreeDialog({ onConfirm, onCancel }: { onConfirm: (branch: string) => void; onCancel: () => void }) {
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
      <form onSubmit={handleSubmit} className="bg-[#1e1e2e] rounded-xl p-6 w-[340px] shadow-2xl border border-white/10">
        <h2 className="text-lg font-semibold text-white mb-4">New Worktree</h2>
        <input
          ref={inputRef}
          type="text"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="Branch name"
          className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-white/20"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white rounded-md hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!branch.trim()}
            className="px-4 py-2 text-sm bg-white/10 text-white rounded-md hover:bg-white/20 transition-colors disabled:opacity-50"
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
  const deleteSession = useAppStore((s) => s.deleteSession)
  const setActiveSession = useAppStore((s) => s.setActiveSession)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const addWorktree = useAppStore((s) => s.addWorktree)
  const setActiveTree = useAppStore((s) => s.setActiveTree)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const addCustomAction = useAppStore((s) => s.addCustomAction)
  const updateCustomAction = useAppStore((s) => s.updateCustomAction)
  const deleteCustomAction = useAppStore((s) => s.deleteCustomAction)
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspace)
  const updateWorkspace = useAppStore((s) => s.updateWorkspace)

  const sortedWorkspaces = Object.values(workspaces).sort((a, b) => a.createdAt - b.createdAt)
  const workspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const customActions = workspace?.customActions ?? []

  const [treeBranches, setTreeBranches] = useState<Record<string, Record<number, string>>>({})
  const [showWorktreeDialog, setShowWorktreeDialog] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [confirmedSessions, setConfirmedSessions] = useState<Set<string>>(new Set())
  const [focusMode, setFocusMode] = useState(false)

  const allTrees = workspace?.trees ?? []

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

  // Keybinding listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!activeWorkspaceId) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

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
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [customActions, activeWorkspaceId, runAction, allTrees.length, setActiveTree, setActiveSession, workspace, sortedWorkspaces, setActiveWorkspace])

  const handleCreateWorktree = async (branchName: string) => {
    if (!workspace || !activeWorkspaceId) return
    setShowWorktreeDialog(false)
    const mainRoot = workspace.trees[0].rootDir
    const result = await window.electronAPI.createWorktree(mainRoot, branchName, settings.worktreesDir)
    if (result.success && result.path) {
      addWorktree(activeWorkspaceId, result.path)
    } else {
      window.alert(`Failed to create worktree:\n${result.error}`)
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
  const mutColor = mutedTextColor(wsColor)
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

  return (
    <div className="w-72 flex flex-col transition-colors duration-300">
      {/* Traffic light space + logo placeholder */}
      <div
        className="h-12 flex items-end px-3 pb-1 shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="text-xs font-semibold tracking-wide opacity-40" style={{ color: txtColor }}>
          ORCHESTRA
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {sortedWorkspaces.map((ws, wsIdx) => {
          const isActiveWs = ws.id === activeWorkspaceId
          const wsBranches = treeBranches[ws.id] ?? {}

          return (
            <div key={ws.id} style={{ opacity: isActiveWs ? 1 : 0.5 }} className="transition-opacity duration-200">
              {/* Workspace header */}
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
                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
                    style={{ color: txtColor }}
                  >
                    <Settings01Icon size={14} />
                  </button>
                )}
                <span
                  onClick={(e) => handleDeleteWorkspace(ws.id, e)}
                  className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity cursor-pointer text-xs"
                  style={{ color: txtColor }}
                >
                  ×
                </span>
              </div>

              {/* Expanded content for active workspace */}
              {isActiveWs && (
                <div className="ml-2 pl-2 space-y-0.5" style={{ borderLeft: `1px solid ${borderColor}` }}>
                  {/* New worktree button */}
                  <button
                    onClick={() => setShowWorktreeDialog(true)}
                    className="flex items-center gap-1.5 w-full px-2 py-1 rounded-md text-xs transition-colors hover:opacity-80"
                    style={{ color: mutColor }}
                  >
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <line x1="6" y1="2" x2="6" y2="10" />
                      <line x1="2" y1="6" x2="10" y2="6" />
                    </svg>
                    New worktree
                  </button>

                  {ws.trees.map((tree, treeIdx) => {
                    const branch = wsBranches[treeIdx]
                    const treeSessions = tree.sessionIds.map((id) => sessions[id]).filter(Boolean)
                    const isActiveTree = ws.activeTreeIndex === treeIdx

                    return (
                      <div key={treeIdx} style={{ opacity: isActiveTree ? 1 : 0.45 }} className="transition-opacity duration-200">
                        {/* Branch header */}
                        <div
                          className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md cursor-pointer hover:opacity-80"
                          style={{ color: txtColor }}
                          onClick={() => {
                            if (isActiveTree) {
                              setFocusMode((prev) => !prev)
                            } else {
                              setFocusMode(false)
                              setActiveTree(ws.id, treeIdx)
                            }
                          }}
                        >
                          <BranchIcon color={txtColor} />
                          <span className="truncate" title={branch ?? tree.rootDir}>
                            {branch ?? tree.rootDir.split('/').pop()}
                          </span>
                          {isActiveTree && (
                            <span
                              className="shrink-0 w-1.5 h-1.5 rounded-full"
                              style={{ backgroundColor: txtColor }}
                            />
                          )}
                          <span className="flex-1" />
                          {ws.trees.length > 1 && treeIdx < 9 && (
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
                          <div className="pl-3 space-y-0.5">
                            {treeSessions.map((session, sessionIdx) => (
                              <SessionItem
                                key={session.id}
                                label={session.label}
                                icon={session.actionIcon}
                                isActive={session.id === activeSessionId}
                                wsColor={wsColor}
                                confirmed={confirmedSessions.has(session.id)}
                                kbdHint={isActiveTree && sessionIdx < 9 ? `⌃${sessionIdx + 1}` : undefined}
                                onClick={() => setActiveSession(session.id)}
                                onDelete={() => handleDeleteSession(session.id)}
                              />
                            ))}
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

      {/* Dialogs */}
      {showWorktreeDialog && (
        <WorktreeDialog
          onConfirm={handleCreateWorktree}
          onCancel={() => setShowWorktreeDialog(false)}
        />
      )}
      {showSettings && workspace && (
        <SettingsDialog
          settings={settings}
          customActions={workspace.customActions ?? []}
          wsColor={wsColor}
          onSaveSettings={updateSettings}
          onUpdateAction={(id, updates) => { if (activeWorkspaceId) updateCustomAction(activeWorkspaceId, id, updates) }}
          onDeleteAction={(id) => { if (activeWorkspaceId) deleteCustomAction(activeWorkspaceId, id) }}
          onAddAction={(action) => { if (activeWorkspaceId) addCustomAction(activeWorkspaceId, action) }}
          onUpdateWorkspaceColor={(color) => { if (activeWorkspaceId) updateWorkspace(activeWorkspaceId, { color }) }}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}
