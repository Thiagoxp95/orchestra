import type { ProcessStatus } from '../../../shared/types'

interface SessionItemProps {
  label: string
  processStatus: ProcessStatus
  isActive: boolean
  accentColor: string
  onClick: () => void
  onDelete: () => void
}

function StatusIcon({ status }: { status: ProcessStatus }) {
  if (status === 'claude') {
    return <span className="text-orange-400 text-lg" title="Claude Code">◈</span>
  }
  if (status === 'codex') {
    return <span className="text-green-400 text-lg" title="OpenAI Codex">◇</span>
  }
  return <span className="text-gray-400 text-lg" title="Terminal">◼</span>
}

export function SessionItem({ label, processStatus, isActive, accentColor, onClick, onDelete }: SessionItemProps) {
  return (
    <button
      onClick={onClick}
      className={`group flex items-center gap-2 w-full px-3 py-2 rounded-md transition-colors text-left ${
        isActive ? 'text-white' : 'text-gray-400 hover:text-white hover:bg-white/5'
      }`}
      style={isActive ? { backgroundColor: accentColor + '20', borderLeft: `3px solid ${accentColor}` } : {}}
    >
      <StatusIcon status={processStatus} />
      <span className="text-sm truncate flex-1">{label}</span>
      <span
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-opacity cursor-pointer"
      >
        ×
      </span>
    </button>
  )
}
