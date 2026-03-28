import { useEffect, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isLightColor } from '../utils/color'
import type { Doc } from '../../../../../backend/convex/_generated/dataModel'

const STATUSES = [
  { value: 'shaping', label: 'Shaping' },
  { value: 'todo', label: 'Todo' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'in_review', label: 'In Review' },
  { value: 'done', label: 'Done' },
] as const

const STATUS_COLORS: Record<string, string> = {
  shaping: '#a855f7',
  todo: '#8b8b8b',
  in_progress: '#f59e0b',
  in_review: '#3b82f6',
  done: '#22c55e',
}

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
  onNavigate: (direction: 'up' | 'down') => void
}

export function IssueDetailPanel({
  issue,
  labels,
  wsColor,
  txtColor,
  onClose,
  onStatusChange,
  onNavigate,
}: IssueDetailPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const isLight = isLightColor(wsColor)
  const bg = isLight ? 'rgba(255,255,255,0.85)' : 'rgba(20,20,35,0.95)'
  const priority = PRIORITY_LABELS[issue.priority] ?? PRIORITY_LABELS[0]
  const statusColor = STATUS_COLORS[issue.status] ?? '#8b8b8b'
  const issueLabels = labels.filter((l) => issue.labelIds.includes(l._id))

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
          {issue.linearUrl && (
            <a
              href={issue.linearUrl}
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
          )}
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
          value={issue.status}
          onChange={(e) => onStatusChange(issue._id, e.target.value)}
          className="text-xs px-2 py-1 rounded-md border appearance-none cursor-pointer"
          style={{
            backgroundColor: `${statusColor}22`,
            borderColor: `${statusColor}44`,
            color: txtColor,
          }}
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value} style={{ backgroundColor: isLight ? '#fff' : '#1a1a2e', color: isLight ? '#000' : '#fff' }}>
              {s.label}
            </option>
          ))}
        </select>

        <span
          className="text-[10px] px-2 py-0.5 rounded-full"
          style={{ backgroundColor: `${priority.color}22`, color: priority.color }}
        >
          {priority.label}
        </span>

        {issue.assigneeName && (
          <span className="text-xs opacity-70">{issue.assigneeName}</span>
        )}
      </div>

      {issueLabels.length > 0 && (
        <div className="px-4 pb-3 flex flex-wrap gap-1">
          {issueLabels.map((label) => (
            <span
              key={label._id}
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
          <div className="text-sm leading-6 opacity-80">
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => <h1 className="text-xl font-bold mt-3 mb-2" style={{ color: txtColor }}>{children}</h1>,
                h2: ({ children }) => <h2 className="text-lg font-bold mt-3 mb-1.5" style={{ color: txtColor }}>{children}</h2>,
                h3: ({ children }) => <h3 className="text-base font-semibold mt-2 mb-1" style={{ color: txtColor }}>{children}</h3>,
                p: ({ children }) => <p className="mb-2" style={{ color: txtColor }}>{children}</p>,
                ul: ({ children }) => <ul className="list-disc pl-5 mb-2" style={{ color: txtColor }}>{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-5 mb-2" style={{ color: txtColor }}>{children}</ol>,
                li: ({ children }) => <li className="mb-0.5" style={{ color: txtColor }}>{children}</li>,
                code: ({ children, className }) => {
                  const isBlock = className?.includes('language-')
                  return isBlock
                    ? <pre className="rounded-md p-3 my-2 text-xs overflow-x-auto" style={{ backgroundColor: `${txtColor}10` }}><code>{children}</code></pre>
                    : <code className="rounded px-1 py-0.5 text-xs" style={{ backgroundColor: `${txtColor}10` }}>{children}</code>
                },
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 pl-3 my-2 opacity-70" style={{ borderColor: `${txtColor}40` }}>{children}</blockquote>
                ),
                a: ({ children, href }) => <a href={href} className="underline opacity-80" target="_blank" rel="noopener noreferrer">{children}</a>,
                strong: ({ children }) => <strong className="font-bold">{children}</strong>,
                em: ({ children }) => <em className="italic">{children}</em>,
                hr: () => <hr className="my-3 border-0 h-px" style={{ backgroundColor: `${txtColor}15` }} />,
                table: ({ children }) => <table className="border-collapse my-2 w-full text-xs">{children}</table>,
                th: ({ children }) => <th className="border px-2 py-1 text-left font-semibold" style={{ borderColor: `${txtColor}20` }}>{children}</th>,
                td: ({ children }) => <td className="border px-2 py-1" style={{ borderColor: `${txtColor}20` }}>{children}</td>,
              }}
            >
              {issue.description}
            </Markdown>
          </div>
        ) : (
          <p className="text-sm opacity-40 italic">No description</p>
        )}
      </div>
    </div>
  )
}
