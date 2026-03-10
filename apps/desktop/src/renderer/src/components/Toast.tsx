import type { IdleNotification } from '../../../shared/types'
import { DynamicIcon } from './DynamicIcon'

interface ToastEntry extends IdleNotification {
  id: string
  fadingOut: boolean
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

  return (
    <button
      onClick={() => {
        onNavigate()
        onDismiss()
      }}
      className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg cursor-pointer
        transition-all duration-300 hover:scale-[1.02] hover:brightness-110
        ${entry.fadingOut ? 'opacity-0 -translate-y-4' : 'opacity-100 translate-y-0 animate-toast-in'}`}
      style={{ backgroundColor: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', maxWidth: '420px' }}
    >
      <span className="shrink-0 opacity-80">
        <DynamicIcon name={icon} size={18} color="#fff" />
      </span>
      <div className="flex flex-col items-start gap-0.5 min-w-0">
        <span className="text-sm font-medium text-white/90 whitespace-nowrap">{entry.summary}</span>
        {entry.description && (
          <span className="text-xs text-white/50 line-clamp-2 text-left">{entry.description}</span>
        )}
      </div>
    </button>
  )
}

export type { ToastEntry }
