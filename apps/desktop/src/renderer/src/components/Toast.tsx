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

  return (
    <button
      onClick={() => {
        onNavigate()
        onDismiss()
      }}
      className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg cursor-pointer
        transition-all duration-300 hover:scale-[1.02] hover:brightness-110
        ${entry.fadingOut ? 'opacity-0 -translate-y-4' : 'opacity-100 translate-y-0 animate-toast-in'}`}
      style={{ backgroundColor: bg, border: `1px solid ${borderColor}`, maxWidth: '420px' }}
    >
      <span className="shrink-0 opacity-80">
        <DynamicIcon name={icon} size={18} color={iconTint} />
      </span>
      <div className="flex flex-col items-start gap-0.5 min-w-0">
        <span className="text-sm font-medium whitespace-nowrap" style={{ color: textPrimary }}>{entry.summary}</span>
        {entry.description && (
          <span className="text-xs line-clamp-2 text-left" style={{ color: textSecondary }}>{entry.description}</span>
        )}
      </div>
    </button>
  )
}

export type { ToastEntry }
