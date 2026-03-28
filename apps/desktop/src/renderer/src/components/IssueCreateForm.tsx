import { useState, useRef, useEffect } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Doc, Id } from '../../../../../backend/convex/_generated/dataModel'

type IssueStatus = 'shaping' | 'todo' | 'in_progress' | 'in_review' | 'done'

const STATUSES: { value: IssueStatus; label: string; color: string }[] = [
  { value: 'shaping', label: 'Shaping', color: '#a855f7' },
  { value: 'todo', label: 'Todo', color: '#8b8b8b' },
  { value: 'in_progress', label: 'In Progress', color: '#f59e0b' },
  { value: 'in_review', label: 'In Review', color: '#3b82f6' },
  { value: 'done', label: 'Done', color: '#22c55e' },
]

const PRIORITIES: { value: number; label: string; color: string }[] = [
  { value: 0, label: 'No priority', color: '#8b8b8b' },
  { value: 1, label: 'Urgent', color: '#f76a6a' },
  { value: 2, label: 'High', color: '#f59e0b' },
  { value: 3, label: 'Medium', color: '#3b82f6' },
  { value: 4, label: 'Low', color: '#6b7280' },
]

export interface CreateIssueData {
  title: string
  description?: string
  status: IssueStatus
  priority: number
  labelIds: Id<'issueLabels'>[]
}

interface IssueCreateFormProps {
  defaultStatus: IssueStatus
  labels: Doc<'issueLabels'>[]
  wsColor: string
  txtColor: string
  isLight: boolean
  onSubmit: (data: CreateIssueData) => void
  onCancel: () => void
}

export function IssueCreateForm({
  defaultStatus,
  labels,
  wsColor,
  txtColor,
  isLight,
  onSubmit,
  onCancel,
}: IssueCreateFormProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [descTab, setDescTab] = useState<'write' | 'preview'>('write')
  const [status, setStatus] = useState<IssueStatus>(defaultStatus)
  const [priority, setPriority] = useState(0)
  const [selectedLabelIds, setSelectedLabelIds] = useState<Id<'issueLabels'>[]>([])
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  const handleSubmit = () => {
    if (!title.trim()) return
    onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      status,
      priority,
      labelIds: selectedLabelIds,
    })
  }

  const toggleLabel = (id: Id<'issueLabels'>) => {
    setSelectedLabelIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  const currentStatus = STATUSES.find((s) => s.value === status)!
  const currentPriority = PRIORITIES.find((p) => p.value === priority)!
  const panelBg = isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)'
  const tabActive = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.1)'

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div
        className="w-[580px] rounded-xl shadow-2xl border flex flex-col overflow-hidden"
        style={{
          backgroundColor: wsColor,
          borderColor: `${txtColor}15`,
          color: txtColor,
          maxHeight: '70vh',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <span className="text-xs opacity-40">New issue</span>
          <button
            onClick={onCancel}
            className="text-sm opacity-40 hover:opacity-100 transition-opacity"
          >
            x
          </button>
        </div>

        {/* Title */}
        <div className="px-5">
          <input
            ref={titleRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Issue title"
            className="w-full text-lg font-medium bg-transparent outline-none placeholder:opacity-30"
            style={{ color: txtColor }}
          />
        </div>

        {/* Description tabs */}
        <div className="px-5 pt-3 flex items-center gap-1">
          <button
            onClick={() => setDescTab('write')}
            className="text-[11px] px-2.5 py-1 rounded-md transition-colors"
            style={{
              backgroundColor: descTab === 'write' ? tabActive : 'transparent',
              color: txtColor,
              opacity: descTab === 'write' ? 1 : 0.5,
            }}
          >
            Write
          </button>
          <button
            onClick={() => setDescTab('preview')}
            className="text-[11px] px-2.5 py-1 rounded-md transition-colors"
            style={{
              backgroundColor: descTab === 'preview' ? tabActive : 'transparent',
              color: txtColor,
              opacity: descTab === 'preview' ? 1 : 0.5,
            }}
          >
            Preview
          </button>
        </div>

        {/* Description body */}
        <div className="px-5 pt-2 flex-1 min-h-0">
          {descTab === 'write' ? (
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add description... (supports Markdown)"
              className="w-full h-40 text-sm bg-transparent outline-none resize-none placeholder:opacity-30 leading-6 font-mono"
              style={{ color: txtColor }}
            />
          ) : (
            <div
              className="h-40 overflow-y-auto text-sm leading-6 prose-invert"
              style={{ color: txtColor }}
            >
              {description.trim() ? (
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
                  {description}
                </Markdown>
              ) : (
                <p className="opacity-30 text-sm">Nothing to preview</p>
              )}
            </div>
          )}
        </div>

        {/* Bottom bar */}
        <div className="px-5 py-3 border-t flex items-center justify-between gap-3" style={{ borderColor: `${txtColor}10` }}>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Status */}
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as IssueStatus)}
              className="text-[11px] px-2.5 py-1.5 rounded-full border appearance-none cursor-pointer"
              style={{
                backgroundColor: `${currentStatus.color}22`,
                borderColor: `${currentStatus.color}44`,
                color: txtColor,
              }}
            >
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value} style={{ backgroundColor: isLight ? '#fff' : '#111' }}>
                  {s.label}
                </option>
              ))}
            </select>

            {/* Priority */}
            <select
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              className="text-[11px] px-2.5 py-1.5 rounded-full border appearance-none cursor-pointer"
              style={{
                backgroundColor: `${currentPriority.color}22`,
                borderColor: `${currentPriority.color}44`,
                color: txtColor,
              }}
            >
              {PRIORITIES.map((p) => (
                <option key={p.value} value={p.value} style={{ backgroundColor: isLight ? '#fff' : '#111' }}>
                  {p.label}
                </option>
              ))}
            </select>

            {/* Labels */}
            {labels.map((label) => (
              <button
                key={label._id}
                onClick={() => toggleLabel(label._id)}
                className="text-[11px] px-2.5 py-1.5 rounded-full border transition-colors"
                style={{
                  borderColor: selectedLabelIds.includes(label._id) ? `${label.color}88` : `${label.color}44`,
                  backgroundColor: selectedLabelIds.includes(label._id) ? `${label.color}22` : 'transparent',
                  color: label.color,
                }}
              >
                {label.name}
              </button>
            ))}
          </div>

          <button
            onClick={handleSubmit}
            disabled={!title.trim()}
            className="text-xs font-medium px-4 py-2 rounded-lg transition-opacity disabled:opacity-30 shrink-0"
            style={{
              backgroundColor: panelBg,
              color: txtColor,
            }}
          >
            Create issue
          </button>
        </div>
      </div>
    </div>
  )
}
