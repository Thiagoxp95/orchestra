import type { IdleNotification } from '../../../shared/types'
import { DynamicIcon } from './DynamicIcon'
import { isLightColor } from '../utils/color'

interface ToastEntry extends IdleNotification {
  id: string
  fadingOut: boolean
  workspaceColor?: string
}

interface ToastProps {
  notifications: ToastEntry[]
  onDismiss: (id: string) => void
  onNavigate: (sessionId: string) => void
}

export function ToastContainer({ notifications, onDismiss, onNavigate }: ToastProps) {
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none items-center">
      {notifications.map((n) => (
        <ToastItem
          key={n.id}
          entry={n}
          onDismiss={() => onDismiss(n.id)}
          onNavigate={() => onNavigate(n.sessionId)}
        />
      ))}
    </div>
  )
}

function ToastItem({
  entry,
  onDismiss,
  onNavigate
}: {
  entry: ToastEntry
  onDismiss: () => void
  onNavigate: () => void
}) {
  const icon = entry.agentType === 'claude' ? '__claude__' : '__openai__'
  const bg = entry.workspaceColor || '#1a1a2e'
  const light = isLightColor(bg)
  const textPrimary = light ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.9)'
  const textSecondary = light ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)'
  const iconTint = light ? '#1a1a1a' : '#fff'
  const borderColor = light ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.1)'
  const accentColor = entry.requiresUserInput ? '#f6c453' : textSecondary
  const statusText = entry.requiresUserInput
    ? `${entry.agentType === 'claude' ? 'Claude' : 'Codex'} needs your input`
    : `${entry.agentType === 'claude' ? 'Claude' : 'Codex'} finished work`

  return (
    <button
      onClick={() => {
        onNavigate()
        onDismiss()
      }}
      className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg cursor-pointer
        transition-all duration-300 hover:scale-[1.02] hover:brightness-110
        ${entry.fadingOut ? 'opacity-0 -translate-y-4' : 'opacity-100 translate-y-0 animate-toast-in'}`}
      style={{ backgroundColor: bg, border: `1px solid ${borderColor}`, maxWidth: import.meta.env.DEV ? '560px' : '440px' }}
    >
      <span className="relative shrink-0 opacity-80">
        <DynamicIcon name={icon} size={18} color={iconTint} />
        {entry.requiresUserInput && (
          <span
            className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: accentColor, boxShadow: `0 0 0 2px ${bg}` }}
          />
        )}
      </span>
      <div className="flex flex-col items-start gap-1 min-w-0">
        <span
          className="text-[10px] font-semibold uppercase tracking-[0.18em] text-left"
          style={{ color: accentColor }}
        >
          {statusText}
        </span>
        <span
          className="text-[15px] leading-tight font-semibold text-left line-clamp-2"
          style={{ color: textPrimary }}
        >
          {entry.title}
        </span>
        {entry.description && (
          <span
            className="text-[11px] leading-snug line-clamp-3 text-left"
            style={{ color: textSecondary }}
          >
            {entry.description}
          </span>
        )}
        {import.meta.env.DEV && entry.debugLastResponse && (
          <div
            className="mt-1.5 pt-1.5 text-left w-full"
            style={{ borderTop: `1px solid ${borderColor}` }}
          >
            <span
              className="text-[9px] font-mono uppercase tracking-wider block mb-0.5"
              style={{ color: accentColor, opacity: 0.7 }}
            >
              Analysis: requiresUserInput={String(entry.requiresUserInput)}
            </span>
            <span
              className="text-[10px] font-mono leading-snug block whitespace-pre-wrap break-all"
              style={{ color: textSecondary, maxHeight: '120px', overflowY: 'auto' }}
            >
              {entry.debugLastResponse.slice(0, 500)}
              {entry.debugLastResponse.length > 500 ? '…' : ''}
            </span>
          </div>
        )}
      </div>
    </button>
  )
}

export type { ToastEntry }
