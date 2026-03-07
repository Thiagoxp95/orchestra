import { ComputerTerminal01Icon, SparklesIcon, SourceCodeSquareIcon } from 'hugeicons-react'
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
    return <SparklesIcon className="text-orange-400" size={18} title="Claude Code" />
  }
  if (status === 'codex') {
    return <SourceCodeSquareIcon className="text-green-400" size={18} title="OpenAI Codex" />
  }
  return <ComputerTerminal01Icon className="text-gray-400" size={18} title="Terminal" />
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
