import { useState, useEffect } from 'react'
import type { WorktreeBackupMeta } from '../../../shared/types'

interface WorktreeBackupsDialogProps {
  /** Main repo (tree index 0) of the workspace — filters the backup list. */
  mainRepoDir: string
  /** Called with the restored path so the caller can re-add it to the workspace. */
  onRestored: (path: string) => void
  onCancel: () => void
}

/** Mirrors BACKUP_RETENTION_MS in main/worktree-backup.ts. */
const RETENTION_DAYS = 30

function formatAge(createdAt: number): string {
  const mins = Math.floor((Date.now() - createdAt) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** How long is left before the retention sweep deletes this backup for good. */
function formatExpiry(createdAt: number): string {
  const msLeft = createdAt + RETENTION_DAYS * 24 * 60 * 60 * 1000 - Date.now()
  if (msLeft <= 0) return 'expiring now'
  const days = Math.floor(msLeft / (24 * 60 * 60 * 1000))
  if (days >= 1) return `deleted for good in ${days}d`
  const hours = Math.max(1, Math.floor(msLeft / (60 * 60 * 1000)))
  return `deleted for good in ${hours}h`
}

export function WorktreeBackupsDialog({ mainRepoDir, onRestored, onCancel }: WorktreeBackupsDialogProps) {
  const [backups, setBackups] = useState<WorktreeBackupMeta[] | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    window.electronAPI.listWorktreeBackups(mainRepoDir).then(setBackups)
  }, [mainRepoDir])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const handleRestore = async (backup: WorktreeBackupMeta) => {
    setRestoringId(backup.id)
    setErrors((prev) => ({ ...prev, [backup.id]: '' }))
    try {
      const result = await window.electronAPI.restoreWorktreeBackup(backup.id)
      if (result.success && result.path) {
        // A partial restore (e.g. patch didn't apply cleanly) still re-adds the
        // tree — the warning tells the user where the saved patch lives.
        if (result.error) setErrors((prev) => ({ ...prev, [backup.id]: result.error! }))
        onRestored(result.path)
      } else {
        setErrors((prev) => ({ ...prev, [backup.id]: result.error ?? 'Restore failed' }))
      }
    } catch (err: any) {
      setErrors((prev) => ({ ...prev, [backup.id]: err?.message ?? 'Restore failed' }))
    } finally {
      setRestoringId(null)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onCancel}>
      <div
        className="bg-[#1e1e2e] rounded-lg p-6 w-[540px] shadow-xl max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-white text-lg font-semibold mb-1">Recently deleted worktrees</h2>
        <p className="text-gray-400 text-xs mb-4">
          Deleted worktrees are backed up for {RETENTION_DAYS} days — branch, uncommitted changes,
          untracked files, and session history. Restore recreates the worktree exactly as it was.
          After {RETENTION_DAYS} days the backup is deleted for good.
        </p>

        {backups === null ? (
          <div className="text-gray-400 text-sm py-4">Loading…</div>
        ) : backups.length === 0 ? (
          <div className="text-gray-400 text-sm py-4">No backups for this workspace yet.</div>
        ) : (
          <div className="space-y-2">
            {backups.map((b) => (
              <div key={b.id} className="bg-[#2a2a3e] rounded p-3">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-white text-sm font-medium truncate">
                      {b.branch || `detached @ ${b.headSha.slice(0, 8)}`}
                    </div>
                    <div className="text-gray-400 text-xs truncate">{b.worktreeDir}</div>
                    <div className="text-gray-500 text-xs mt-0.5">
                      {formatAge(b.createdAt)}
                      {b.dirty
                        ? ` · uncommitted work${b.untrackedCount ? ` + ${b.untrackedCount} untracked file${b.untrackedCount === 1 ? '' : 's'}` : ''}`
                        : ' · clean'}
                      {b.sessionCount > 0 && ` · ${b.sessionCount} session${b.sessionCount === 1 ? '' : 's'}`}
                      {` · ${formatExpiry(b.createdAt)}`}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRestore(b)}
                    disabled={restoringId !== null}
                    className="px-3 py-1.5 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-500 disabled:opacity-50 transition-colors shrink-0"
                  >
                    {restoringId === b.id ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
                {errors[b.id] && (
                  <div className="text-amber-400 text-xs mt-2 break-words">{errors[b.id]}</div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end mt-4">
          <button onClick={onCancel} className="px-4 py-2 text-gray-400 hover:text-white transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
