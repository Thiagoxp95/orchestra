interface WorkspaceTabProps {
  name: string
  color: string
  isActive: boolean
  onClick: () => void
  onDelete: () => void
}

export function WorkspaceTab({ name, color, isActive, onClick, onDelete }: WorkspaceTabProps) {
  return (
    <button
      onClick={onClick}
      className={`group flex items-center gap-2 px-4 py-2 rounded-t-lg transition-colors ${
        isActive ? 'bg-[#1a1a2e] text-white' : 'bg-[#12121e] text-gray-400 hover:text-white'
      }`}
    >
      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
      <span className="text-sm font-medium truncate max-w-[120px]">{name}</span>
      <span
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        className="ml-1 opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-opacity cursor-pointer"
      >
        ×
      </span>
    </button>
  )
}
