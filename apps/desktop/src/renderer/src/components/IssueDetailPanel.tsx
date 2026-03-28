import { useEffect, useState, useCallback, useRef } from 'react'
import { RichTextEditor } from './RichTextEditor'
import { StatusIcon } from './StatusIcon'
import { isLightColor } from '../utils/color'
import type { Doc } from '../../../../../backend/convex/_generated/dataModel'

const STATUSES = [
  { value: 'shaping', label: 'Shaping' },
  { value: 'todo', label: 'Todo' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'in_review', label: 'In Review' },
  { value: 'done', label: 'Done' },
] as const

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'No priority', color: '#8b8b8b' },
  1: { label: 'Urgent', color: '#f76a6a' },
  2: { label: 'High', color: '#f59e0b' },
  3: { label: 'Medium', color: '#3b82f6' },
  4: { label: 'Low', color: '#6b7280' },
}

interface IssueDetailPanelProps {
  issue: Doc<'issues'>
  labels: Doc<'issueLabels'>[]
  wsColor: string
  txtColor: string
  onClose: () => void
  onStatusChange: (issueId: string, status: string) => void
  onUpdate: (issueId: string, fields: { title?: string; description?: string }) => void
  onNavigate: (direction: 'up' | 'down') => void
}

export function IssueDetailPanel({
  issue,
  labels,
  wsColor,
  txtColor,
  onClose,
  onStatusChange,
  onUpdate,
  onNavigate,
}: IssueDetailPanelProps) {
  const isLight = isLightColor(wsColor)
  const priority = PRIORITY_LABELS[issue.priority] ?? PRIORITY_LABELS[0]
  const [title, setTitle] = useState(issue.title)
  const titleDebounceRef = useRef<ReturnType<typeof setTimeout>>()
  const descDebounceRef = useRef<ReturnType<typeof setTimeout>>()

  // Sync title when navigating to a different issue
  useEffect(() => { setTitle(issue.title) }, [issue._id])

  const handleTitleChange = useCallback((value: string) => {
    setTitle(value)
    clearTimeout(titleDebounceRef.current)
    titleDebounceRef.current = setTimeout(() => {
      if (value.trim()) onUpdate(issue._id, { title: value.trim() })
    }, 500)
  }, [issue._id, onUpdate])

  const handleDescriptionChange = useCallback((html: string) => {
    clearTimeout(descDebounceRef.current)
    descDebounceRef.current = setTimeout(() => {
      onUpdate(issue._id, { description: html })
    }, 500)
  }, [issue._id, onUpdate])
  const issueLabels = labels.filter((l) => issue.labelIds.includes(l._id))
  const sidebarBg = isLight ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.03)'

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'ArrowUp') { e.preventDefault(); onNavigate('up') }
      if (e.key === 'ArrowDown') { e.preventDefault(); onNavigate('down') }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, onNavigate])

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ color: txtColor }}>
      {/* Top bar — breadcrumb back to board */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0 border-b"
        style={{ borderColor: `${txtColor}10` }}
      >
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="text-xs opacity-50 hover:opacity-100 transition-opacity flex items-center gap-1.5"
            style={{ color: txtColor }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 12L6 8l4-4" />
            </svg>
            Issues
          </button>
          <span className="text-xs opacity-20">/</span>
          <span className="text-xs font-mono opacity-50">{issue.identifier}</span>
          <span className="text-xs opacity-50 truncate max-w-[300px]">{issue.title}</span>
        </div>
        <div className="flex items-center gap-2">
          {issue.linearUrl && (
            <a
              href={issue.linearUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs opacity-40 hover:opacity-100 transition-opacity"
              title="Open in Linear"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4" />
                <path d="M7 9l7-7" />
                <path d="M10 2h4v4" />
              </svg>
            </a>
          )}
          <button
            onClick={() => onNavigate('up')}
            className="text-xs opacity-30 hover:opacity-80 transition-opacity"
            title="Previous issue"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 10l4-4 4 4" />
            </svg>
          </button>
          <button
            onClick={() => onNavigate('down')}
            className="text-xs opacity-30 hover:opacity-80 transition-opacity"
            title="Next issue"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
        </div>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left — title + description */}
        <div className="flex-1 overflow-y-auto px-10 py-8">
          <input
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            className="w-full text-2xl font-bold leading-tight mb-6 bg-transparent outline-none"
            style={{ color: txtColor }}
          />

          <div style={{ color: txtColor }}>
            <RichTextEditor
              content={issue.description || ''}
              onChange={handleDescriptionChange}
              placeholder="Add description..."
              wsColor={wsColor}
              txtColor={txtColor}
              isLight={isLight}
              editable={true}
            />
          </div>
        </div>

        {/* Right — properties sidebar */}
        <div
          className="w-[240px] shrink-0 border-l overflow-y-auto px-4 py-6 space-y-5"
          style={{ borderColor: `${txtColor}08`, backgroundColor: sidebarBg }}
        >
          {/* Status */}
          <div>
            <label className="text-[10px] uppercase tracking-wider opacity-40 block mb-2">Status</label>
            <div className="flex items-center gap-2">
              <StatusIcon status={issue.status} size={14} />
              <select
                value={issue.status}
                onChange={(e) => onStatusChange(issue._id, e.target.value)}
                className="text-xs bg-transparent border-none appearance-none cursor-pointer outline-none"
                style={{ color: txtColor }}
              >
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value} style={{ backgroundColor: isLight ? '#fff' : '#111' }}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Priority */}
          <div>
            <label className="text-[10px] uppercase tracking-wider opacity-40 block mb-2">Priority</label>
            <span
              className="text-xs px-2 py-0.5 rounded-full inline-block"
              style={{ backgroundColor: `${priority.color}22`, color: priority.color }}
            >
              {priority.label}
            </span>
          </div>

          {/* Assignee */}
          {issue.assigneeName && (
            <div>
              <label className="text-[10px] uppercase tracking-wider opacity-40 block mb-2">Assignee</label>
              <div className="flex items-center gap-2">
                <div
                  className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold"
                  style={{ backgroundColor: isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)' }}
                >
                  {issue.assigneeAvatarUrl ? (
                    <img src={issue.assigneeAvatarUrl} alt="" className="w-full h-full rounded-full object-cover" />
                  ) : (
                    issue.assigneeName.charAt(0).toUpperCase()
                  )}
                </div>
                <span className="text-xs">{issue.assigneeName}</span>
              </div>
            </div>
          )}

          {/* Labels */}
          {issueLabels.length > 0 && (
            <div>
              <label className="text-[10px] uppercase tracking-wider opacity-40 block mb-2">Labels</label>
              <div className="flex flex-wrap gap-1">
                {issueLabels.map((label) => (
                  <span
                    key={label._id}
                    className="text-[10px] px-2 py-0.5 rounded-full"
                    style={{
                      backgroundColor: `${label.color}22`,
                      color: label.color,
                      border: `1px solid ${label.color}44`,
                    }}
                  >
                    {label.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
