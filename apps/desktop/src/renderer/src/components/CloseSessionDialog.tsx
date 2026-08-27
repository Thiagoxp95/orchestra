import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'
import { textColor } from '../utils/color'

/**
 * The one confirmation in front of closing a session.
 *
 * Every close path parks its request in `pendingSessionClose` rather than acting
 * (see the store), so the row's ×, a middle-click, the close-session shortcut and
 * a worktree's "close all" all land here. Closing kills the PTY: the agent's
 * conversation can be resumed later, but whatever it had in flight is gone.
 *
 * Enter confirms, Escape cancels — the dialog is meant to cost one keystroke when
 * you did mean it, and to exist at all when you didn't.
 */
export function CloseSessionDialog(): React.ReactElement | null {
  const pending = useAppStore((s) => s.pendingSessionClose)
  const cancelSessionClose = useAppStore((s) => s.cancelSessionClose)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)

  const wsColor = (activeWorkspaceId ? workspaces[activeWorkspaceId]?.color : undefined) ?? '#1a1a2e'
  const txtColor = textColor(wsColor)

  useEffect(() => {
    if (!pending) return
    const confirm = (): void => {
      for (const sid of pending.sessionIds) {
        window.electronAPI.killTerminal(sid)
        deleteSession(sid)
      }
      cancelSessionClose()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); cancelSessionClose() }
      if (e.key === 'Enter') { e.stopPropagation(); confirm() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pending, cancelSessionClose, deleteSession])

  if (!pending) return null

  const count = pending.sessionIds.length
  const confirmNow = (): void => {
    for (const sid of pending.sessionIds) {
      window.electronAPI.killTerminal(sid)
      deleteSession(sid)
    }
    cancelSessionClose()
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" onClick={cancelSessionClose}>
      <div
        className="rounded-xl p-6 w-[400px] shadow-2xl border border-white/10"
        style={{ backgroundColor: wsColor }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-2" style={{ color: txtColor }}>
          {count === 1 ? 'Close this session?' : `Close ${count} sessions?`}
        </h2>
        <p className="text-sm mb-4 opacity-70 break-words" style={{ color: txtColor }}>
          {count === 1 ? (
            <>
              <span className="font-medium">{pending.label}</span> will be terminated. Anything the
              agent has in flight is lost — the conversation can still be resumed later.
            </>
          ) : (
            <>
              Every session in <span className="font-medium">{pending.label}</span> will be
              terminated. Anything those agents have in flight is lost.
            </>
          )}
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={cancelSessionClose}
            className="px-4 py-2 text-sm rounded-md hover:bg-white/5 transition-colors opacity-70 hover:opacity-100"
            style={{ color: txtColor }}
          >
            Cancel
          </button>
          <button
            onClick={confirmNow}
            autoFocus
            className="px-4 py-2 text-sm bg-white/10 rounded-md hover:bg-white/20 transition-colors"
            style={{ color: txtColor }}
          >
            {count === 1 ? 'Close session' : 'Close all'}
          </button>
        </div>
      </div>
    </div>
  )
}
