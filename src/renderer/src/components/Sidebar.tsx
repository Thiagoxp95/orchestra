import { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'
import { SessionItem } from './SessionItem'
import { DynamicIcon } from './DynamicIcon'
import { AddActionDialog } from './AddActionDialog'
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
  const addWorktree = useAppStore((s) => s.addWorktree)
  const setActiveTree = useAppStore((s) => s.setActiveTree)
  const settings = useAppStore((s) => s.settings)
  const addCustomAction = useAppStore((s) => s.addCustomAction)

  const workspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const customActions = workspace?.customActions ?? []
  const [treeBranches, setTreeBranches] = useState<Record<number, string>>({})
  const [showWorktreeDialog, setShowWorktreeDialog] = useState(false)
  const [showActionDialog, setShowActionDialog] = useState(false)
  const [confirmedSessions, setConfirmedSessions] = useState<Set<string>>(new Set())

  const allTrees = workspace?.trees ?? []

  // Git branch polling for ALL trees
  useEffect(() => {
    if (!workspace) {
      setTreeBranches({})
      return
    }
    const fetchBranches = () => {
      workspace.trees.forEach((tree, idx) => {
        window.electronAPI.getGitBranch(tree.rootDir).then((branch) => {
          if (branch) setTreeBranches((prev) => ({ ...prev, [idx]: branch }))
        })
      })
    }
    fetchBranches()
    const interval = setInterval(fetchBranches, 5000)
    return () => clearInterval(interval)
  }, [workspace?.trees.length, workspace?.trees.map((t) => t.rootDir).join(',')])

  // Keybinding listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!activeWorkspaceId) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      // Cmd+1..9 to switch worktrees
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1
        if (idx < allTrees.length) {
          e.preventDefault()
          setActiveTree(activeWorkspaceId, idx)
          return
        }
      }

      // Ctrl+1..9 to switch sessions within active worktree
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        const activeTree = workspace ? allTrees[workspace.activeTreeIndex] : null
        if (activeTree) {
          const idx = parseInt(e.key) - 1
          if (idx < activeTree.sessionIds.length) {
            e.preventDefault()
            setActiveSession(activeTree.sessionIds[idx])
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
  }, [customActions, activeWorkspaceId, runAction, allTrees.length, setActiveTree, setActiveSession, workspace])

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

  const totalSessions = allTrees.reduce((sum, t) => sum + t.sessionIds.length, 0)

  return (
    <div className="w-72 flex flex-col transition-colors duration-300">
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {/* New worktree button */}
        <button
          onClick={() => setShowWorktreeDialog(true)}
          disabled={!activeWorkspaceId}
          className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 rounded-md text-xs transition-colors disabled:opacity-50 hover:opacity-80 mb-1"
          style={{ color: txtColor, border: `1px dashed ${borderColor}` }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="6" y1="2" x2="6" y2="10" />
            <line x1="2" y1="6" x2="10" y2="6" />
          </svg>
          New worktree
        </button>
        {allTrees.map((tree, treeIdx) => {
          const branch = treeBranches[treeIdx]
          const treeSessions = tree.sessionIds.map((id) => sessions[id]).filter(Boolean)
          const isActiveTree = workspace ? workspace.activeTreeIndex === treeIdx : false
          return (
            <div key={treeIdx} style={{ opacity: isActiveTree ? 1 : 0.45 }} className="transition-opacity duration-200">
              {/* Branch header */}
              <div
                className="flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md cursor-pointer hover:opacity-80"
                style={{ color: txtColor }}
                onClick={() => activeWorkspaceId && setActiveTree(activeWorkspaceId, treeIdx)}
              >
                <BranchIcon color={txtColor} />
                <span className="truncate flex-1" title={branch ?? tree.rootDir}>
                  {branch ?? tree.rootDir.split('/').pop()}
                </span>
                {allTrees.length > 1 && treeIdx < 9 && (
                  <kbd
                    className="shrink-0 text-[10px] font-mono leading-none px-1 py-0.5 rounded border"
                    style={{ color: txtColor, borderColor: `${txtColor}33`, opacity: 0.5 }}
                  >
                    ⌘{treeIdx + 1}
                  </kbd>
                )}
                {isActiveTree && (
                  <span
                    className="shrink-0 w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: txtColor }}
                  />
                )}
              </div>
              {/* Indented sessions */}
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
            </div>
          )
        })}
        {totalSessions === 0 && (
          <p className="text-sm text-center py-4" style={{ color: mutColor }}>No sessions yet</p>
        )}
      </div>
      <div className="p-2 border-t flex items-center justify-center gap-2 flex-wrap" style={{ borderColor }}>
        {customActions.map((action) => (
          <button
            key={action.id}
            onClick={() => handleRunAction(action)}
            disabled={!activeWorkspaceId}
            title={`${action.name}${action.keybinding ? ` (${action.keybinding})` : ''}`}
            className="p-2 rounded-md transition-colors disabled:opacity-50 hover:opacity-80"
            style={{ color: txtColor }}
          >
            <DynamicIcon name={action.icon} size={18} color={txtColor} />
          </button>
        ))}
        {/* Add action button */}
        <button
          onClick={() => setShowActionDialog(true)}
          disabled={!activeWorkspaceId}
          title="Add custom action"
          className="p-1.5 rounded-md transition-colors disabled:opacity-50 hover:opacity-80"
          style={{ color: txtColor }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeDasharray="3 2">
            <rect x="2" y="2" width="16" height="16" rx="4" />
            <line x1="10" y1="6" x2="10" y2="14" strokeDasharray="none" />
            <line x1="6" y1="10" x2="14" y2="10" strokeDasharray="none" />
          </svg>
        </button>
      </div>
      {showWorktreeDialog && (
        <WorktreeDialog
          onConfirm={handleCreateWorktree}
          onCancel={() => setShowWorktreeDialog(false)}
        />
      )}
      {showActionDialog && (
        <AddActionDialog
          onSave={(action) => { if (activeWorkspaceId) addCustomAction(activeWorkspaceId, action); setShowActionDialog(false) }}
          onCancel={() => setShowActionDialog(false)}
        />
      )}
    </div>
  )
}
