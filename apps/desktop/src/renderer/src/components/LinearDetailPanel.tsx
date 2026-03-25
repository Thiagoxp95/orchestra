import { useEffect, useRef } from 'react'
import type { LinearIssue, LinearWorkflowState } from '../../../shared/linear-types'
import { isLightColor } from '../utils/color'

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'No priority', color: '#8b8b8b' },
  1: { label: 'Urgent', color: '#f76a6a' },
  2: { label: 'High', color: '#f59e0b' },
  3: { label: 'Medium', color: '#3b82f6' },
  4: { label: 'Low', color: '#6b7280' },
}

interface LinearDetailPanelProps {
  issue: LinearIssue
  columns: LinearWorkflowState[]
  wsColor: string
  txtColor: string
  onClose: () => void
  onStatusChange: (issueId: string, stateId: string) => void
  onNavigate: (direction: 'up' | 'down') => void
}

export function LinearDetailPanel({
  issue,
  columns,
  wsColor,
  txtColor,
  onClose,
  onStatusChange,
  onNavigate,
}: LinearDetailPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const isLight = isLightColor(wsColor)
  const bg = isLight ? 'rgba(255,255,255,0.85)' : 'rgba(20,20,35,0.95)'
  const priority = PRIORITY_LABELS[issue.priority] ?? PRIORITY_LABELS[0]

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
    <div
      ref={panelRef}
      className="w-[400px] shrink-0 border-l overflow-y-auto"
      style={{
        backgroundColor: bg,
        borderColor: `${txtColor}15`,
        color: txtColor,
      }}
    >
      <div className="sticky top-0 flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: `${txtColor}10`, backgroundColor: bg }}>
        <span className="text-xs font-mono opacity-50">{issue.identifier}</span>
        <div className="flex items-center gap-2">
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs opacity-50 hover:opacity-100 transition-opacity"
            title="Open in Linear"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4" />
              <path d="M7 9l7-7" />
              <path d="M10 2h4v4" />
            </svg>
          </a>
          <button
            onClick={onClose}
            className="text-sm opacity-50 hover:opacity-100 transition-opacity"
          >
            x
          </button>
        </div>
      </div>

      <div className="px-4 pt-4 pb-3">
        <h2 className="text-base font-semibold leading-6">{issue.title}</h2>
      </div>

      <div className="px-4 pb-3 flex flex-wrap items-center gap-2">
        <select
          value={issue.state.id}
          onChange={(e) => onStatusChange(issue.id, e.target.value)}
          className="text-xs px-2 py-1 rounded-md border appearance-none cursor-pointer"
          style={{
            backgroundColor: `${issue.state.color}22`,
            borderColor: `${issue.state.color}44`,
            color: txtColor,
          }}
        >
          {columns.map((col) => (
            <option key={col.id} value={col.id} style={{ backgroundColor: isLight ? '#fff' : '#1a1a2e', color: isLight ? '#000' : '#fff' }}>
              {col.name}
            </option>
          ))}
        </select>

        <span
          className="text-[10px] px-2 py-0.5 rounded-full"
          style={{ backgroundColor: `${priority.color}22`, color: priority.color }}
        >
          {priority.label}
        </span>

        {issue.assignee && (
          <span className="text-xs opacity-70">{issue.assignee.displayName}</span>
        )}
      </div>

      {issue.labels.nodes.length > 0 && (
        <div className="px-4 pb-3 flex flex-wrap gap-1">
          {issue.labels.nodes.map((label) => (
            <span
              key={label.id}
              className="text-[10px] px-1.5 py-0.5 rounded-full"
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
      )}

      <div className="px-4 pb-6 border-t pt-4" style={{ borderColor: `${txtColor}10` }}>
        {issue.description ? (
          <pre className="text-sm leading-6 whitespace-pre-wrap font-sans opacity-80">{issue.description}</pre>
        ) : (
          <p className="text-sm opacity-40 italic">No description</p>
        )}
      </div>
    </div>
  )
}
