import { ComputerTerminal01Icon } from 'hugeicons-react'
import type { ProcessStatus } from '../../../shared/types'

interface SessionItemProps {
  label: string
  processStatus: ProcessStatus
  isActive: boolean
  accentColor: string
  onClick: () => void
  onDelete: () => void
}

function ClaudeLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="opacity-60 shrink-0">
      <path
        d="M16.734 2.059a1.238 1.238 0 0 0-1.524.624L8.09 17.473a1.238 1.238 0 1 0 2.247 1.043L17.456 3.72a1.238 1.238 0 0 0-.722-1.66ZM8.676 5.208a1.238 1.238 0 0 0-1.6.46l-5.14 8.676a1.238 1.238 0 0 0 .46 1.688l3.573 2.116a1.238 1.238 0 1 0 1.263-2.131l-2.178-1.29 4.082-6.888a1.238 1.238 0 0 0-.46-1.63ZM21.05 8.657a1.238 1.238 0 0 0-1.262 2.132l2.177 1.289-4.081 6.888a1.238 1.238 0 0 0 1.14 1.876 1.238 1.238 0 0 0 .46-.088l.077-.042 5.14-8.676a1.238 1.238 0 0 0-.46-1.688l-3.19-1.69Z"
        fill="#9ca3af"
      />
    </svg>
  )
}

function OpenAILogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="opacity-60 shrink-0">
      <path
        d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.998 5.998 0 0 0-3.998 2.9 6.042 6.042 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.516 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073ZM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494ZM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646ZM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872v.024Zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667Zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66v.019Zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681l-.004 6.722Zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5-.005-2.999Z"
        fill="#9ca3af"
      />
    </svg>
  )
}

function StatusIcon({ status }: { status: ProcessStatus }) {
  if (status === 'claude') {
    return <span title="Claude Code"><ClaudeLogo /></span>
  }
  if (status === 'codex') {
    return <span title="OpenAI Codex"><OpenAILogo /></span>
  }
  return <span title="Terminal"><ComputerTerminal01Icon className="text-gray-400" size={18} /></span>
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
