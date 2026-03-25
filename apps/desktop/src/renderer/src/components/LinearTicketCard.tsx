import type { LinearIssue } from '../../../shared/linear-types'

const PRIORITY_COLORS: Record<number, string> = {
  0: '#8b8b8b',
  1: '#f76a6a',
  2: '#f59e0b',
  3: '#3b82f6',
  4: '#6b7280',
}

interface LinearTicketCardProps {
  issue: LinearIssue
  txtColor: string
  isLight: boolean
  onClick: () => void
  onDragStart: (e: React.DragEvent) => void
}

export function LinearTicketCard({ issue, txtColor, isLight, onClick, onDragStart }: LinearTicketCardProps) {
  const bg = isLight ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.06)'
  const hoverBg = isLight ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.1)'
  const labels = issue.labels.nodes.slice(0, 2)
  const overflowCount = issue.labels.nodes.length - 2

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      className="rounded-lg px-3 py-2.5 cursor-pointer transition-colors group"
      style={{ backgroundColor: bg, color: txtColor }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = hoverBg }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = bg }}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: PRIORITY_COLORS[issue.priority] ?? PRIORITY_COLORS[0] }}
          title={issue.priorityLabel}
        />
        <span className="text-[10px] font-mono opacity-50">{issue.identifier}</span>
      </div>
      <div className="text-sm leading-5 line-clamp-2">{issue.title}</div>
      <div className="flex items-center justify-between mt-2 gap-2">
        <div className="flex items-center gap-1 min-w-0 overflow-hidden">
          {labels.map((label) => (
            <span
              key={label.id}
              className="text-[10px] px-1.5 py-0.5 rounded-full truncate max-w-[80px]"
              style={{
                backgroundColor: `${label.color}22`,
                color: label.color,
                border: `1px solid ${label.color}44`,
              }}
            >
              {label.name}
            </span>
          ))}
          {overflowCount > 0 && (
            <span className="text-[10px] opacity-40">+{overflowCount}</span>
          )}
        </div>
        {issue.assignee && (
          <div
            className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-[9px] font-bold"
            style={{
              backgroundColor: isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)',
            }}
            title={issue.assignee.displayName}
          >
            {issue.assignee.avatarUrl ? (
              <img
                src={issue.assignee.avatarUrl}
                alt=""
                className="w-full h-full rounded-full object-cover"
              />
            ) : (
              issue.assignee.displayName.charAt(0).toUpperCase()
            )}
          </div>
        )}
      </div>
    </div>
  )
}
