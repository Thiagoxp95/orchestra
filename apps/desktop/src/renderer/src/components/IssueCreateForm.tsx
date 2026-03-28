import { useState, useRef, useEffect } from 'react'
import { RichTextEditor } from './RichTextEditor'
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

        {/* Description */}
        <div className="px-5 pt-3 flex-1 min-h-0 overflow-y-auto">
          <RichTextEditor
            content={description}
            onChange={setDescription}
            placeholder="Add description..."
            txtColor={txtColor}
            isLight={isLight}
          />
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
