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
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
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
        ${entry.fadingOut ? 'opacity-0 translate-x-4' : 'opacity-100 translate-x-0 animate-toast-in'}`}
      style={{ backgroundColor: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)' }}
    >
      <span className="shrink-0 opacity-80">
        <DynamicIcon name={icon} size={18} color="#fff" />
      </span>
      <span className="text-sm text-white/90 whitespace-nowrap">{entry.summary}</span>
    </button>
  )
}

export type { ToastEntry }
