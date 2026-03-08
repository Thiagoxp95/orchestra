import { useState, useEffect } from 'react'
import { useAppStore, getActiveTree } from '../store/app-store'
import { textColor, isLightColor } from '../utils/color'
import { darkenColor } from './TerminalArea'

interface DiffFile {
  file: string
  added: number
  removed: number
  status: string
}

const STATUS_COLORS: Record<string, string> = {
  M: '#e2b93d',
  A: '#3fb950',
  D: '#f85149',
  U: '#8b949e',
}

const STATUS_LABELS: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  U: 'Untracked',
}

function fileIcon(status: string) {
  const color = STATUS_COLORS[status] ?? '#8b949e'
  if (status === 'D') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" className="shrink-0">
        <line x1="4" y1="8" x2="12" y2="8" />
      </svg>
    )
  }
  if (status === 'A' || status === 'U') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" className="shrink-0">
        <line x1="8" y1="4" x2="8" y2="12" />
        <line x1="4" y1="8" x2="12" y2="8" />
      </svg>
    )
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" className="shrink-0">
      <circle cx="8" cy="8" r="3" />
    </svg>
  )
}

export function DiffPanel({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<DiffFile[]>([])
  const [loading, setLoading] = useState(true)

  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const diffSelectedFile = useAppStore((s) => s.diffSelectedFile)
  const setDiffSelectedFile = useAppStore((s) => s.setDiffSelectedFile)
  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const tree = activeWorkspace ? getActiveTree(activeWorkspace) : null
  const wsColor = activeWorkspace?.color ?? '#2a2a3e'
  const panelBg = darkenColor(wsColor)
  const txtColor = textColor(wsColor)
  const borderColor = isLightColor(wsColor) ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.08)'

  useEffect(() => {
    if (!tree?.rootDir) {
      setFiles([])
      setLoading(false)
      return
    }
    setLoading(true)
    window.electronAPI.getGitDiffFiles(tree.rootDir).then((result) => {
      setFiles(result)
      setLoading(false)
    })
    const interval = setInterval(() => {
      window.electronAPI.getGitDiffFiles(tree.rootDir).then(setFiles)
    }, 5000)
    return () => clearInterval(interval)
  }, [tree?.rootDir])

  // Group files by directory
  const grouped: Record<string, DiffFile[]> = {}
  for (const f of files) {
    const parts = f.file.split('/')
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.'
    if (!grouped[dir]) grouped[dir] = []
    grouped[dir].push(f)
  }
  const sortedDirs = Object.keys(grouped).sort()

  return (
    <div
      className="w-72 shrink-0 flex flex-col rounded-xl overflow-hidden ml-2"
      style={{ backgroundColor: panelBg }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2.5 shrink-0"
        style={{ borderBottom: `1px solid ${borderColor}` }}
      >
        <span className="text-xs font-semibold" style={{ color: txtColor, opacity: 0.7 }}>
          Changes ({files.length})
        </span>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:opacity-80 transition-opacity"
          style={{ color: txtColor, opacity: 0.5 }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="4" y1="4" x2="12" y2="12" />
            <line x1="12" y1="4" x2="4" y2="12" />
          </svg>
        </button>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto py-1">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs" style={{ color: txtColor, opacity: 0.4 }}>Loading...</span>
          </div>
        )}
        {!loading && files.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs" style={{ color: txtColor, opacity: 0.4 }}>No changes</span>
          </div>
        )}
        {!loading && sortedDirs.map((dir) => (
          <div key={dir}>
            {dir !== '.' && (
              <div
                className="px-3 py-1 text-[10px] font-mono truncate"
                style={{ color: txtColor, opacity: 0.35 }}
              >
                {dir}/
              </div>
            )}
            {grouped[dir].map((f) => {
              const fileName = f.file.split('/').pop()
              const statusColor = STATUS_COLORS[f.status] ?? '#8b949e'
              return (
                <div
                  key={f.file}
                  className={`group flex items-center gap-2 px-3 py-1 hover:bg-white/5 transition-colors cursor-pointer ${diffSelectedFile === f.file ? 'bg-white/10' : ''}`}
                  title={`${f.file} — ${STATUS_LABELS[f.status] ?? f.status}`}
                  onClick={() => setDiffSelectedFile(diffSelectedFile === f.file ? null : f.file)}
                >
                  {fileIcon(f.status)}
                  <span
                    className="flex-1 text-xs truncate"
                    style={{ color: statusColor }}
                  >
                    {fileName}
                  </span>
                  {(f.added > 0 || f.removed > 0) && (
                    <span className="shrink-0 text-[10px] font-mono flex items-center gap-1" style={{ opacity: 0.6 }}>
                      {f.added > 0 && <span style={{ color: '#3fb950' }}>+{f.added}</span>}
                      {f.removed > 0 && <span style={{ color: '#f85149' }}>-{f.removed}</span>}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
