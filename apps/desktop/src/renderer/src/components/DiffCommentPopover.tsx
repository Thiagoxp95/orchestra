import { useRef, useEffect } from 'react'

interface DiffCommentPopoverProps {
  lineNumber: number
  side: 'deletions' | 'additions'
  onSend: (agent: 'claude' | 'codex', comment: string) => void
  onClose: () => void
  commentText: string
  onCommentChange: (text: string) => void
}

export function DiffCommentPopover({
  lineNumber,
  side,
  onSend,
  onClose,
  commentText,
  onCommentChange,
}: DiffCommentPopoverProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  const sideLabel = side === 'additions' ? '+' : '-'

  return (
    <div
      className="mx-2 my-1 rounded-lg border overflow-hidden"
      style={{
        backgroundColor: '#1a1a2e',
        borderColor: 'rgba(255,255,255,0.1)',
        maxWidth: 480,
      }}
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-mono"
        style={{ color: 'rgba(255,255,255,0.5)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <span>Line {lineNumber} ({sideLabel})</span>
      </div>

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={commentText}
        onChange={(e) => onCommentChange(e.target.value)}
        placeholder="Describe what to fix..."
        rows={3}
        className="w-full px-3 py-2 text-xs bg-transparent outline-none resize-none"
        style={{ color: 'rgba(255,255,255,0.85)' }}
      />

      {/* Actions */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
      >
        <button
          onClick={() => commentText.trim() && onSend('claude', commentText)}
          disabled={!commentText.trim()}
          className="px-3 py-1 rounded text-[11px] font-medium transition-opacity"
          style={{
            backgroundColor: '#d97706',
            color: '#fff',
            opacity: commentText.trim() ? 1 : 0.4,
          }}
        >
          Claude
        </button>
        <button
          onClick={() => commentText.trim() && onSend('codex', commentText)}
          disabled={!commentText.trim()}
          className="px-3 py-1 rounded text-[11px] font-medium transition-opacity"
          style={{
            backgroundColor: '#10a37f',
            color: '#fff',
            opacity: commentText.trim() ? 1 : 0.4,
          }}
        >
          Codex
        </button>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="text-[10px] px-2 py-1 rounded hover:bg-white/5 transition-colors"
          style={{ color: 'rgba(255,255,255,0.4)' }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
