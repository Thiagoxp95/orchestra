import { useEffect, useRef } from 'react'
import { textColor, isLightColor } from '../utils/color'
import { DynamicIcon } from './DynamicIcon'

interface SessionItemProps {
  label: string
  icon?: string
  isActive: boolean
  wsColor: string
  confirmed?: boolean
  kbdHint?: string
  isWorking?: boolean
  needsApproval?: boolean
  needsUserInput?: boolean
  statusLabel?: string
  agentResponse?: string
  onClick: () => void
  onDelete: () => void
}

export function SessionItem({
  label,
  icon,
  isActive,
  wsColor,
  confirmed,
  kbdHint,
  isWorking,
  needsApproval,
  needsUserInput,
  statusLabel,
  agentResponse,
  onClick,
  onDelete,
}: SessionItemProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const light = isLightColor(wsColor)
  const txtClr = textColor(wsColor)
  const hoverBg = light ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)'
  const activeBg = light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)'
  const isAgent = icon === '__claude__' || icon === '__openai__'
  const showNeedsInputAnimation = Boolean((needsUserInput || needsApproval) && !isActive)
  const statusColor = needsUserInput ? '#f6c453' : needsApproval ? '#60a5fa' : txtClr

  useEffect(() => {
    if (isActive && ref.current) {
      ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [isActive])

  return (
    <button
      ref={ref}
      onClick={onClick}
      onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onDelete() } }}
      className="group flex items-center gap-2 w-full px-3 py-2 rounded-md transition-colors text-left"
      style={{
        color: txtClr,
        backgroundColor: isActive ? activeBg : undefined
      }}
      onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = hoverBg }}
      onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = '' }}
    >
      <span
        className={`relative shrink-0 ${
          showNeedsInputAnimation
            ? 'animate-session-attention'
            : isWorking && isAgent
              ? 'animate-spin'
              : 'opacity-60'
        }`}
      >
        <DynamicIcon name={icon || '__terminal__'} size={18} color={txtClr} />
        {(needsUserInput || needsApproval) && (
          <span
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: statusColor, boxShadow: `0 0 0 2px ${wsColor}` }}
          />
        )}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`text-sm truncate block ${isWorking ? 'shimmer-active' : ''}`}
            style={isWorking ? {
              '--shimmer-color': txtClr,
              '--shimmer-highlight': `${txtClr}55`,
            } as React.CSSProperties : undefined}
          >
            {label}
          </span>
          {statusLabel && (
            <span
              className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full border"
              style={{
                color: statusColor,
                borderColor: `${statusColor}55`,
                backgroundColor: `${statusColor}18`,
              }}
            >
              {statusLabel}
            </span>
          )}
        </div>
        {agentResponse && (
          <span
            className="text-[11px] leading-tight block truncate mt-0.5"
            style={{ color: txtClr, opacity: 0.5 }}
            title={agentResponse}
          >
            {agentResponse}
          </span>
        )}
      </div>
      {confirmed ? (
        <span className="shrink-0 animate-[checkFade_1.5s_ease-out_forwards]">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={txtClr} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3,7 6,10 11,4" />
          </svg>
        </span>
      ) : (
        <>
          {kbdHint && (
            <kbd
              className="shrink-0 text-[10px] font-mono leading-none px-1 py-0.5 rounded border opacity-40 group-hover:hidden"
              style={{ color: txtClr, borderColor: `${txtClr}33` }}
            >
              {kbdHint}
            </kbd>
          )}
          <span
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            className="hidden group-hover:inline opacity-60 transition-opacity cursor-pointer shrink-0"
            style={{ color: txtClr }}
          >
            ×
          </span>
        </>
      )}
    </button>
  )
}
