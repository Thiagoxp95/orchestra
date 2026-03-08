import { useState, useEffect } from 'react'
import { useAppStore, getActiveTree } from '../store/app-store'
import { textColor, diffColors } from '../utils/color'
import { DynamicIcon } from './DynamicIcon'
import { AddActionDialog } from './AddActionDialog'
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog'
import { Kbd } from './Kbd'

export function NavBar() {
  const [diffStat, setDiffStat] = useState<{ added: number; removed: number } | null>(null)
  const [showActionDialog, setShowActionDialog] = useState(false)
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false)
  const [confirmedActions, setConfirmedActions] = useState<Set<string>>(new Set())
  const [runningActions, setRunningActions] = useState<Set<string>>(new Set())

  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const runAction = useAppStore((s) => s.runAction)
  const addCustomAction = useAppStore((s) => s.addCustomAction)
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const toggleDiffPanel = useAppStore((s) => s.toggleDiffPanel)
  const showDiffPanel = useAppStore((s) => s.showDiffPanel)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)

  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const tree = activeWorkspace ? getActiveTree(activeWorkspace) : null
  const wsColor = activeWorkspace?.color ?? '#2a2a3e'
  const txtColor = textColor(wsColor)
  const diff = diffColors(wsColor)
  const customActions = activeWorkspace?.customActions ?? []

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

  const handleRunAction = async (action: typeof customActions[number]) => {
    if (!activeWorkspaceId) return

    if (action.runInBackground) {
      if (runningActions.has(action.id)) return
      setRunningActions((prev) => new Set(prev).add(action.id))
      const cwd = tree?.rootDir ?? '~'
      let cmd = action.command
      const aType = action.actionType ?? 'cli'
      if (aType === 'claude' && cmd) {
        const escaped = cmd.replace(/'/g, "'\\''")
        cmd = `claude --dangerously-skip-permissions -p '${escaped}'`
      } else if (aType === 'codex' && cmd) {
        const escaped = cmd.replace(/'/g, "'\\''")
        cmd = `codex --dangerously-skip-permissions -p '${escaped}'`
      }
      const result = await window.electronAPI.runBackgroundCommand(cwd, cmd)
      setRunningActions((prev) => {
        const next = new Set(prev)
        next.delete(action.id)
        return next
      })
      if (result.success) {
        setConfirmedActions((prev) => new Set(prev).add(action.id))
        setTimeout(() => {
          setConfirmedActions((prev) => {
            const next = new Set(prev)
            next.delete(action.id)
            return next
          })
        }, 2000)
      }
      return
    }

    runAction(activeWorkspaceId, action)
  }

  const handleCreateWorkspace = (name: string, color: string, rootDir: string) => {
    const workspaceId = createWorkspace(name, color, rootDir)
    const ws = useAppStore.getState().workspaces[workspaceId]
    const tree = ws?.trees[ws.activeTreeIndex]
    if (tree?.sessionIds[0]) {
      window.electronAPI.createTerminal(tree.sessionIds[0], { cwd: rootDir })
    }
    setShowCreateWorkspace(false)
  }

  return (
    <>
      <div className="flex items-center h-11 transition-colors duration-300">
        {/* New workspace button - aligned under sidebar */}
        <div className={`${sidebarCollapsed ? 'w-20' : 'w-72'} shrink-0 flex items-center justify-center px-2 transition-all duration-300`}>
          <button
            onClick={() => setShowCreateWorkspace(true)}
            className={`flex items-center justify-center gap-1.5 w-full py-1.5 rounded-lg text-xs transition-colors hover:opacity-80`}
            style={{
              color: txtColor,
              border: `1.5px dashed ${txtColor}44`,
            }}
            title={sidebarCollapsed ? 'New workspace' : undefined}
          >
            <span>+</span>
            {!sidebarCollapsed && <span>New workspace</span>}
          </button>
        </div>

        {/* Terminal-area footer: centered actions */}
        <div className="flex-1 flex items-center justify-center px-2">
          {/* Actions - centered */}
          <div className="flex items-center gap-1">
            {customActions.map((action) => {
              const isConfirmed = confirmedActions.has(action.id)
              const isRunning = runningActions.has(action.id)
              return (
              <div key={action.id} className="relative group">
                <button
                  onClick={() => handleRunAction(action)}
                  disabled={!activeWorkspaceId || isRunning}
                  className="p-2 rounded-md transition-colors disabled:opacity-50 hover:opacity-80"
                  style={{ color: txtColor }}
                >
                  {isConfirmed ? (
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke={txtColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 9 8 13 14 5" />
                    </svg>
                  ) : isRunning ? (
                    <svg width="18" height="18" viewBox="0 0 18 18" className="animate-spin" fill="none" stroke={txtColor} strokeWidth="1.5" strokeLinecap="round">
                      <path d="M9 2a7 7 0 0 1 7 7" />
                    </svg>
                  ) : (
                    <DynamicIcon name={action.icon} size={18} color={txtColor} />
                  )}
                </button>
                <div className="absolute bottom-full right-0 mb-1.5 px-2.5 py-1.5 rounded-lg text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity bg-black/90 text-white flex items-center gap-2">
                  <span>{action.name}</span>
                  {action.keybinding && <Kbd shortcut={action.keybinding} />}
                </div>
              </div>
              )
            })}
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
        </div>

        {/* Diff stat - far right */}
        {diffStat && (diffStat.added > 0 || diffStat.removed > 0) && (
          <button
            onClick={toggleDiffPanel}
            title="Toggle diff panel (⌘⇧D)"
            className="shrink-0 flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 rounded-md mr-2 hover:brightness-110 active:brightness-95 transition-all cursor-pointer"
            style={{
              backgroundColor: showDiffPanel ? `${txtColor}25` : `${txtColor}12`,
              border: `1px solid ${showDiffPanel ? `${txtColor}40` : `${txtColor}20`}`,
            }}
          >
            <span style={{ color: diff.added }}>+{diffStat.added}</span>
            <span style={{ color: diff.removed }}>-{diffStat.removed}</span>
          </button>
        )}
      </div>

      {showActionDialog && (
        <AddActionDialog
          wsColor={wsColor}
          onSave={(action) => { if (activeWorkspaceId) addCustomAction(activeWorkspaceId, action); setShowActionDialog(false) }}
          onCancel={() => setShowActionDialog(false)}
        />
      )}
      {showCreateWorkspace && (
        <CreateWorkspaceDialog
          onConfirm={handleCreateWorkspace}
          onCancel={() => setShowCreateWorkspace(false)}
        />
      )}
    </>
  )
}
