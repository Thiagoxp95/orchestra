import { textColor, isLightColor } from '../utils/color'
import { DynamicIcon } from './DynamicIcon'

interface SessionItemProps {
  label: string
  icon?: string
  isActive: boolean
  wsColor: string
  confirmed?: boolean
  kbdHint?: string
  onClick: () => void
  onDelete: () => void
}

export function SessionItem({ label, icon, isActive, wsColor, confirmed, kbdHint, onClick, onDelete }: SessionItemProps) {
  const light = isLightColor(wsColor)
  const txtClr = textColor(wsColor)
  const hoverBg = light ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)'
  const activeBg = light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)'

  return (
    <button
      onClick={onClick}
      className="group flex items-center gap-2 w-full px-3 py-2 rounded-md transition-colors text-left"
      style={{
        color: txtClr,
        backgroundColor: isActive ? activeBg : undefined
      }}
      onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = hoverBg }}
      onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = '' }}
    >
      <span className="opacity-60 shrink-0">
        <DynamicIcon name={icon || '__terminal__'} size={18} color={txtClr} />
      </span>
      <span className="text-sm truncate flex-1">{label}</span>
      {kbdHint && !confirmed && (
        <kbd
          className="shrink-0 text-[10px] font-mono leading-none px-1 py-0.5 rounded border opacity-40"
          style={{ color: txtClr, borderColor: `${txtClr}33` }}
        >
          {kbdHint}
        </kbd>
      )}
      {confirmed ? (
        <span className="shrink-0 animate-[checkFade_1.5s_ease-out_forwards]">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={txtClr} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3,7 6,10 11,4" />
          </svg>
        </span>
      ) : (
        <span
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="opacity-0 group-hover:opacity-60 transition-opacity cursor-pointer shrink-0"
          style={{ color: txtClr }}
        >
          ×
        </span>
      )}
    </button>
  )
}
