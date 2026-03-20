import { useState, useEffect } from 'react'
import { useAppStore, getActiveTree } from '../store/app-store'
import { textColor } from '../utils/color'
import { DynamicIcon } from './DynamicIcon'
import { AddActionDialog } from './AddActionDialog'
import { SkillsDrawer } from './SkillsDrawer'

import { Kbd } from './Kbd'
import { Tooltip } from './Tooltip'

function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return '<1M'
  if (mb < 1024) return `${Math.round(mb)}M`
  return `${(mb / 1024).toFixed(1)}G`
}

export function NavBar() {
  const [showActionDialog, setShowActionDialog] = useState(false)
  const [showSkillsDrawer, setShowSkillsDrawer] = useState(false)

  const [confirmedActions, setConfirmedActions] = useState<Set<string>>(new Set())
  const [runningActions, setRunningActions] = useState<Set<string>>(new Set())
  const [sessionMemory, setSessionMemory] = useState<Record<string, number>>({})

  const workspaces = useAppStore((s) => s.workspaces)
  const sessions = useAppStore((s) => s.sessions)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const runAction = useAppStore((s) => s.runAction)
  const addCustomAction = useAppStore((s) => s.addCustomAction)

  const maestroMode = useAppStore((s) => s.maestroMode)


  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const tree = activeWorkspace ? getActiveTree(activeWorkspace) : null
  const wsColor = activeWorkspace?.color ?? '#2a2a3e'
  const txtColor = textColor(wsColor)
  const customActions = activeWorkspace?.customActions ?? []

  // Memory usage polling
  useEffect(() => {
    const fetchMemory = () => {
      window.electronAPI.getSessionsMemory().then(setSessionMemory)
    }
    fetchMemory()
    const interval = setInterval(fetchMemory, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleRunAction = async (action: typeof customActions[number]) => {
    if (!activeWorkspaceId) return
    const aType = action.actionType ?? 'cli'

    if (action.runInBackground) {
      if (aType === 'claude' || aType === 'codex') {
        runAction(activeWorkspaceId, { ...action, runInBackground: false })
        return
      }

      if (runningActions.has(action.id)) return
      setRunningActions((prev) => new Set(prev).add(action.id))
      const cwd = tree?.rootDir ?? '~'
      const result = await window.electronAPI.runBackgroundCommand(cwd, action.command)
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

  return (
    <>
      <div className="relative flex items-center h-11 transition-colors duration-300">
        {/* Actions - left aligned */}
        <div className="flex items-center gap-1 px-2">
          {/* Maestro mode badge */}
          {maestroMode && (
            <div
              className="flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold tracking-widest shrink-0 mr-1"
              style={{
                color: txtColor,
                backgroundColor: `${wsColor}`,
                border: `1px solid ${txtColor}30`
              }}
            >
              MAESTRO
            </div>
          )}
            {customActions.map((action) => {
              const isConfirmed = confirmedActions.has(action.id)
              const isRunning = runningActions.has(action.id)
              return (
              <Tooltip
                key={action.id}
                side="top"
                bgColor={wsColor}
                textColor={txtColor}
                text={<span className="flex items-center gap-2"><span>{action.name}</span>{action.keybinding && <Kbd shortcut={action.keybinding} />}</span>}
              >
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
              </Tooltip>
              )
            })}
            <button
              onClick={() => setShowActionDialog(true)}
              disabled={!activeWorkspaceId}
              title="Add custom action"
              className="p-1.5 rounded-md transition-colors disabled:opacity-50 opacity-30 hover:opacity-60"
              style={{ color: txtColor }}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeDasharray="3 2">
                <rect x="2" y="2" width="16" height="16" rx="4" />
                <line x1="10" y1="6" x2="10" y2="14" strokeDasharray="none" />
                <line x1="6" y1="10" x2="14" y2="10" strokeDasharray="none" />
              </svg>
            </button>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right-aligned badges */}
        <div className="flex items-center gap-1.5 px-2 shrink-0">
          {/* Skills button */}
          {tree && (
            <Tooltip side="top" text="Browse skills" bgColor={wsColor} textColor={txtColor}>
              <button
                onClick={() => setShowSkillsDrawer(true)}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono transition-colors hover:opacity-80"
                style={{
                  color: txtColor,
                  backgroundColor: `${txtColor}10`,
                  border: `1px solid ${txtColor}18`,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 2l8 6-8 6V2z" />
                </svg>
                <span>Skills</span>
              </button>
            </Tooltip>
          )}

          {/* Active session memory badge */}
          {activeSessionId && sessionMemory[activeSessionId] && (
            <Tooltip side="top" text={`${sessions[activeSessionId]?.label || activeSessionId.slice(0, 6)} — ${formatMemory(sessionMemory[activeSessionId])}`}>
              <div
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono"
                style={{
                  color: txtColor,
                  backgroundColor: `${txtColor}10`,
                  border: `1px solid ${txtColor}18`,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <rect x="4" y="4" width="8" height="8" rx="1" />
                  <line x1="6" y1="4" x2="6" y2="1" />
                  <line x1="10" y1="4" x2="10" y2="1" />
                  <line x1="6" y1="12" x2="6" y2="15" />
                  <line x1="10" y1="12" x2="10" y2="15" />
                  <line x1="4" y1="6" x2="1" y2="6" />
                  <line x1="4" y1="10" x2="1" y2="10" />
                  <line x1="12" y1="6" x2="15" y2="6" />
                  <line x1="12" y1="10" x2="15" y2="10" />
                </svg>
                <span>{formatMemory(sessionMemory[activeSessionId])}</span>
              </div>
            </Tooltip>
          )}
        </div>
      </div>

      {showActionDialog && (
        <AddActionDialog
          wsColor={wsColor}
          workspaceId={activeWorkspaceId ?? ''}
          worktrees={activeWorkspace?.trees.map((t, i) => ({
            rootDir: t.rootDir,
            label: i === 0 ? 'Base' : t.rootDir.split('/').pop() ?? `Tree ${i}`,
          })) ?? []}
          onSave={(action) => { if (activeWorkspaceId) addCustomAction(activeWorkspaceId, action); setShowActionDialog(false) }}
          onCancel={() => setShowActionDialog(false)}
        />
      )}

      {showSkillsDrawer && tree && (
        <SkillsDrawer
          wsColor={wsColor}
          rootDir={tree.rootDir}
          onClose={() => setShowSkillsDrawer(false)}
        />
      )}
    </>
  )
}
