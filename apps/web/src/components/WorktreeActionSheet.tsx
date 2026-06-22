'use client'
import { useEffect } from 'react'
import { DynamicIcon } from './DynamicIcon'
import { SPIN_UP_AGENTS, type SafeAction, type SpinUpAgent } from '@/lib/actions'

export type WorktreeActionChoice = { agent: SpinUpAgent } | { actionId: string }

/**
 * Bottom-sheet popup for acting on a worktree: open a terminal/agent or run a
 * custom action in that tree. Tapping a choice fires `onChoose` and closes.
 */
export function WorktreeActionSheet({
  title,
  actions,
  onChoose,
  onCancel,
}: {
  title: string
  actions: SafeAction[]
  onChoose: (choice: WorktreeActionChoice) => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const Row = ({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) => (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-foreground transition-colors hover:bg-accent active:bg-accent"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" onClick={onCancel}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full rounded-t-2xl border border-border bg-sidebar p-3 shadow-2xl sm:max-w-sm sm:rounded-2xl"
      >
        <div className="mb-2 truncate px-3 pt-1 text-xs uppercase tracking-wider text-muted-foreground">{title}</div>
        {SPIN_UP_AGENTS.map((agent) => (
          <Row
            key={agent.id}
            icon={<DynamicIcon name={agent.icon} size={18} />}
            label={agent.id === 'terminal' ? 'Open Terminal' : agent.label}
            onClick={() => onChoose({ agent: agent.id })}
          />
        ))}
        {actions.length > 0 && (
          <>
            <div className="my-1 border-t border-border" />
            {actions.map((action) => (
              <Row
                key={action.id}
                icon={<DynamicIcon name={action.icon || '__terminal__'} size={18} />}
                label={action.name}
                onClick={() => onChoose({ actionId: action.id })}
              />
            ))}
          </>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="mt-1 w-full rounded-lg px-3 py-3 text-center text-sm text-muted-foreground transition-colors hover:bg-accent"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
