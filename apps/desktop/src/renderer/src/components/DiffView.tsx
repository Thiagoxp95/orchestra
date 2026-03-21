import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { PatchDiff } from '@pierre/diffs/react'
import type { AnnotationSide, DiffLineAnnotation } from '@pierre/diffs/react'
import { useAppStore, getActiveTree } from '../store/app-store'
import { textColor, isLightColor } from '../utils/color'
import { darkenColor } from './TerminalArea'
import { DiffCommentPopover } from './DiffCommentPopover'
import { extractHunkForLine, getLineContent } from '../utils/diff-hunk-parser'
import { buildActionCommand } from '../../../shared/action-utils'
import type { CustomAction } from '../../../shared/types'

/** Mix a hex color toward black (amt 0–1) */
function mixBlack(hex: string, amt: number): string {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * (1 - amt))
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * (1 - amt))
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * (1 - amt))
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

/** Mix a hex color toward white (amt 0–1) */
function mixWhite(hex: string, amt: number): string {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) + (255 - parseInt(hex.slice(1, 3), 16)) * amt)
  const g = Math.round(parseInt(hex.slice(3, 5), 16) + (255 - parseInt(hex.slice(3, 5), 16)) * amt)
  const b = Math.round(parseInt(hex.slice(5, 7), 16) + (255 - parseInt(hex.slice(5, 7), 16)) * amt)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

export function DiffView({ file, onClose }: { file: string; onClose: () => void }) {
  const [patch, setPatch] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  const [commentLine, setCommentLine] = useState<{ lineNumber: number; side: AnnotationSide } | null>(null)
  const [commentText, setCommentText] = useState('')

  const createSession = useAppStore((s) => s.createSession)

  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const tree = activeWorkspace ? getActiveTree(activeWorkspace) : null
  const wsColor = activeWorkspace?.color ?? '#2a2a3e'
  const panelBg = darkenColor(wsColor)
  const txtColor = textColor(wsColor)
  const borderColor = isLightColor(wsColor) ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.08)'
  const light = isLightColor(wsColor)

  const diffThemeCSS = useMemo(() => {
    const bg = panelBg
    const fg = txtColor
    const mix = light ? mixBlack : mixWhite
    // Derive tinted backgrounds from the workspace color
    const bgBuffer = mix(bg, 0.08)
    const bgContext = mix(bg, 0.04)
    const bgHover = mix(bg, 0.06)
    const bgSeparator = mix(bg, 0.12)
    const fgNumber = light ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.35)'
    return `:host {
  --diffs-bg: ${bg};
  --diffs-fg: ${fg};
  --diffs-bg-buffer-override: ${bgBuffer};
  --diffs-bg-context-override: ${bgContext};
  --diffs-bg-hover-override: ${bgHover};
  --diffs-bg-separator-override: ${bgSeparator};
  --diffs-fg-number-override: ${fgNumber};
}`
  }, [panelBg, txtColor, light])

  useEffect(() => {
    if (!tree?.rootDir) return
    setLoading(true)
    window.electronAPI.getGitFileDiff(tree.rootDir, file).then((raw) => {
      setPatch(raw)
      setLoading(false)
    })
  }, [file, tree?.rootDir])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (commentLine) {
          setCommentLine(null)
          setCommentText('')
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [commentLine, onClose])

  const fileName = file.split('/').pop()
  const dirPath = file.split('/').slice(0, -1).join('/')

  const handleLineClick = useCallback((props: { lineNumber: number; annotationSide: AnnotationSide; event: PointerEvent }) => {
    const { lineNumber, annotationSide } = props
    if (commentLine?.lineNumber === lineNumber && commentLine?.side === annotationSide) {
      setCommentLine(null)
      setCommentText('')
      return
    }
    setCommentLine({ lineNumber, side: annotationSide })
    setCommentText('')
  }, [commentLine])

  const handleSendToAgent = useCallback((agent: 'claude' | 'codex', comment: string) => {
    if (!activeWorkspaceId || !tree?.rootDir || !commentLine) return

    const hunkResult = extractHunkForLine(patch, commentLine.lineNumber, commentLine.side)
    const lineContent = getLineContent(patch, commentLine.lineNumber, commentLine.side)

    const promptParts = [`In file ${file}:`]
    if (hunkResult) {
      promptParts.push(`\nDiff hunk:\n\`\`\`\n${hunkResult.hunkText}\n\`\`\``)
    }
    if (lineContent) {
      promptParts.push(`\nSpecifically line ${commentLine.lineNumber}: ${lineContent}`)
    }
    promptParts.push(`\n${comment}`)
    const prompt = promptParts.join('\n')

    const shellCmd = buildActionCommand({
      actionType: agent,
      command: prompt,
    } as CustomAction)

    if (!shellCmd) return

    const processStatus = agent === 'claude' ? 'claude' : 'codex'

    createSession(
      activeWorkspaceId,
      shellCmd,
      agent === 'claude' ? 'default-claude' : 'default-codex',
      agent === 'claude' ? '__claude__' : '__openai__',
      agent === 'claude' ? 'Claude' : 'Codex',
      processStatus as any,
    )

    setCommentLine(null)
    setCommentText('')
    onClose()
  }, [activeWorkspaceId, tree?.rootDir, patch, commentLine, file, createSession, onClose])

  const lineAnnotations: DiffLineAnnotation[] = commentLine
    ? [{ lineNumber: commentLine.lineNumber, side: commentLine.side }]
    : []

  const handleRenderHoverUtility = useCallback(
    (getHoveredLine: () => { lineNumber: number; side: AnnotationSide } | undefined) => {
      const hovered = getHoveredLine()
      if (!hovered) return null
      return (
        <button
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setCommentLine({ lineNumber: hovered.lineNumber, side: hovered.side })
            setCommentText('')
          }}
          className="flex items-center justify-center rounded hover:bg-blue-500/30 transition-colors"
          style={{
            width: 18,
            height: 18,
            color: '#58a6ff',
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          +
        </button>
      )
    },
    []
  )

  const handleRenderAnnotation = useCallback((_annotation: DiffLineAnnotation) => {
    if (!commentLine) return null
    return (
      <DiffCommentPopover
        lineNumber={commentLine.lineNumber}
        side={commentLine.side}
        commentText={commentText}
        onCommentChange={setCommentText}
        onClose={() => {
          setCommentLine(null)
          setCommentText('')
        }}
        onSend={handleSendToAgent}
      />
    )
  }, [commentLine, commentText, handleSendToAgent])

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
              theme: light ? 'github-light' : 'github-dark',
              themeType: light ? 'light' : 'dark',
              unsafeCSS: diffThemeCSS,
              onLineClick: handleLineClick,
              enableHoverUtility: true,
            }}
            lineAnnotations={lineAnnotations}
            selectedLines={commentLine ? { start: commentLine.lineNumber, end: commentLine.lineNumber, side: commentLine.side } : null}
            renderAnnotation={handleRenderAnnotation}
            renderHoverUtility={handleRenderHoverUtility}
          />
        </div>
      )}
    </div>
  )
}
