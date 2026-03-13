import { useState, useEffect, useRef } from 'react'
import { PatchDiff } from '@pierre/diffs/react'
import { useAppStore, getActiveTree } from '../store/app-store'
import { textColor, isLightColor } from '../utils/color'
import { darkenColor } from './TerminalArea'

export function DiffView({ file, onClose }: { file: string; onClose: () => void }) {
  const [patch, setPatch] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const tree = activeWorkspace ? getActiveTree(activeWorkspace) : null
  const wsColor = activeWorkspace?.color ?? '#2a2a3e'
  const panelBg = darkenColor(wsColor)
  const txtColor = textColor(wsColor)
  const borderColor = isLightColor(wsColor) ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.08)'

  useEffect(() => {
    if (!tree?.rootDir) return
    setLoading(true)
    window.electronAPI.getGitFileDiff(tree.rootDir, file).then((raw) => {
      setPatch(raw)
      setLoading(false)
    })
  }, [file, tree?.rootDir])

  const fileName = file.split('/').pop()
  const dirPath = file.split('/').slice(0, -1).join('/')

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ backgroundColor: panelBg }}>
      {/* Header */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 shrink-0"
        style={{ borderBottom: `1px solid ${borderColor}` }}
      >
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-white/10 transition-colors"
          style={{ color: txtColor }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="10 4 6 8 10 12" />
          </svg>
        </button>
        {dirPath && (
          <span className="text-xs font-mono truncate" style={{ color: txtColor, opacity: 0.5 }}>
            {dirPath}/
          </span>
        )}
        <span className="text-xs font-mono font-semibold" style={{ color: txtColor }}>
          {fileName}
        </span>
      </div>

      {/* Diff content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-xs" style={{ color: txtColor, opacity: 0.4 }}>Loading diff...</span>
        </div>
      ) : (
        <div ref={containerRef} className="flex-1 overflow-auto">
          <PatchDiff
            patch={patch}
            options={{
              diffStyle: 'split',
              theme: 'github-dark',
            }}
          />
        </div>
      )}
    </div>
  )
}
