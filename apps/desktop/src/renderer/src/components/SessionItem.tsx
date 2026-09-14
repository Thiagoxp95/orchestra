import { useEffect, useRef, useState } from 'react'
import { textColor, isLightColor } from '../utils/color'
import { DynamicIcon } from './DynamicIcon'
import { AgentIconMorph } from './AgentIconMorph'

interface SessionItemProps {
  label: string
  icon?: string
  isActive: boolean
  wsColor: string
  confirmed?: boolean
  isWorking?: boolean
  needsApproval?: boolean
  needsUserInput?: boolean
  agentResponse?: string
  /** Pinned sessions render their pin filled and always-visible (see Sidebar). */
  pinned?: boolean
  onClick: () => void
  onDelete: () => void
  onTogglePin?: () => void
  /** Commit a typed title. An empty string clears the custom name. */
  onRename?: (title: string) => void
  /**
   * Reopen this pane on the conversation it was holding. Passed only when the
   * row HAS one recorded and its agent is no longer running — the common case
   * being a restart, which leaves every row here at once.
   */
  onResume?: () => void
}

/** The resume mark: an arrow returning to where it started. */
function ResumeGlyph({ color, size = 13 }: { color: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}

/** The pin mark: filled when pinned, outlined when it's only an offer. */
function PinGlyph({ filled, color, size = 13 }: { filled: boolean; color: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? color : 'none'}
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  )
}

export function SessionItem({
  label,
  icon,
  isActive,
  wsColor,
  confirmed,
  isWorking,
  needsApproval,
  needsUserInput,
  agentResponse,
  pinned,
  onClick,
  onDelete,
  onTogglePin,
  onRename,
  onResume,
}: SessionItemProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(label)
  const light = isLightColor(wsColor)
  const txtClr = textColor(wsColor)
  const hoverBg = light ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)'
  const activeBg = light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)'
  const isAgent = icon === '__claude__' || icon === '__openai__' || icon === '__cursor__'
  const showNeedsInputAnimation = Boolean((needsUserInput || needsApproval) && !isActive)
  const statusColor = needsUserInput ? '#f6c453' : needsApproval ? '#60a5fa' : txtClr

  useEffect(() => {
    if (isActive && ref.current) {
      ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [isActive])

  const startRename = () => {
    if (!onRename) return
    setDraft(label)
    setRenaming(true)
  }

  const commitRename = () => {
    setRenaming(false)
    if (draft.trim() !== label.trim()) onRename?.(draft)
  }

  // Editing swaps the row out rather than nesting an input inside the row's
  // button — a text field inside a button swallows its own clicks and drags.
  if (renaming) {
    return (
      <div
        className="flex items-center gap-2 w-full px-3 py-2 rounded-md"
        style={{ color: txtClr, backgroundColor: activeBg }}
      >
        <span className="shrink-0 inline-flex items-center justify-center opacity-60" style={{ width: 18, height: 18 }}>
          <DynamicIcon name={icon || '__terminal__'} size={18} color={txtClr} />
        </span>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') { e.preventDefault(); commitRename() }
            // Escape abandons the edit; the auto label (or the previous custom
            // one) is untouched because nothing was committed.
            if (e.key === 'Escape') { e.preventDefault(); setRenaming(false) }
          }}
          onClick={(e) => e.stopPropagation()}
          placeholder="Session name"
          className="flex-1 min-w-0 bg-transparent text-sm outline-none border-b"
          style={{ color: txtClr, borderColor: `${txtClr}55` }}
        />
      </div>
    )
  }

  return (
    <button
      ref={ref}
      onClick={onClick}
      onDoubleClick={(e) => { e.stopPropagation(); startRename() }}
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
        className={`relative shrink-0 inline-flex items-center justify-center ${
          showNeedsInputAnimation
            ? 'animate-session-attention'
            : isWorking && isAgent
              ? ''
              : 'opacity-60'
        }`}
        style={{ width: 18, height: 18 }}
      >
        {isAgent ? (
          <AgentIconMorph icon={icon || '__terminal__'} size={18} color={txtClr} working={Boolean(isWorking)} />
        ) : (
          <DynamicIcon name={icon || '__terminal__'} size={18} color={txtClr} />
        )}
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
      {isWorking && isAgent && (
        <span
          className="shrink-0 opacity-70 group-hover:hidden"
          title={icon === '__claude__' ? 'Claude is working' : icon === '__cursor__' ? 'Cursor is working' : 'Codex is working'}
        >
          <DynamicIcon name={icon || '__terminal__'} size={12} color={txtClr} />
        </span>
      )}
      {onResume && (
        <span
          onClick={(e) => { e.stopPropagation(); onResume() }}
          title="Resume this conversation"
          // Always visible, unlike the pin: this row's agent is dead, and the
          // offer to bring it back is the most useful thing about the row until
          // it is taken. Hiding it behind a hover would be hiding the fix.
          className="inline-flex items-center opacity-70 transition-opacity hover:!opacity-100 cursor-pointer shrink-0"
          style={{ color: txtClr }}
        >
          <ResumeGlyph color={txtClr} />
        </span>
      )}
      {onTogglePin && (
        <span
          onClick={(e) => { e.stopPropagation(); onTogglePin() }}
          title={pinned ? 'Unpin session' : 'Pin session'}
          // A pinned session keeps its mark on screen — that's the whole signal.
          // An unpinned one only offers it on hover, so the row stays quiet.
          className={`${pinned ? 'inline-flex opacity-90' : 'hidden group-hover:inline-flex opacity-50'} items-center transition-opacity hover:!opacity-100 cursor-pointer shrink-0`}
          style={{ color: txtClr }}
        >
          <PinGlyph filled={Boolean(pinned)} color={txtClr} />
        </span>
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
          className="hidden group-hover:inline opacity-60 transition-opacity cursor-pointer shrink-0"
          style={{ color: txtClr }}
        >
          ×
        </span>
      )}
    </button>
  )
}
