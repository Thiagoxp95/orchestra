'use client'
import { useEffect, useRef, useState } from 'react'
import { DynamicIcon } from './DynamicIcon'
import { SPIN_UP_AGENTS, type SafeAction, type SpinUpAgent } from '@/lib/actions'

export interface WorktreeDialogResult {
  branch: string
  selectedActionIds: string[]
  spinUp: SpinUpAgent | null
}

// 1:1 port of the desktop WorktreeDialog, themed with shadcn tokens: a branch
// name input, multi-select "Run on creation" action cards, and a single-select
// "Spin up on creation" agent picker.
export function WorktreeDialog({
  workspaceName,
  actions,
  onConfirm,
  onCancel,
}: {
  workspaceName: string
  actions: SafeAction[]
  onConfirm: (result: WorktreeDialogResult) => void
  onCancel: () => void
}) {
  const [branch, setBranch] = useState('')
  const [selectedActionIds, setSelectedActionIds] = useState<Set<string>>(() => new Set())
  const [spinUp, setSpinUp] = useState<SpinUpAgent | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

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

  const toggleAction = (id: string) => {
    setSelectedActionIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (branch.trim()) onConfirm({ branch: branch.trim(), selectedActionIds: [...selectedActionIds], spinUp })
  }

  const OptionCard = ({
    selected,
    onClick,
    icon,
    label,
  }: {
    selected: boolean
    onClick: () => void
    icon: React.ReactNode
    label: string
  }) => (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-9 items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-xs font-medium transition-colors ${
        selected ? 'border-primary bg-accent text-accent-foreground' : 'border-border bg-muted/40 text-muted-foreground'
      }`}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{icon}</span>
      <span>{label}</span>
    </button>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-[360px] rounded-xl border border-border bg-sidebar p-6 shadow-2xl"
      >
        <h2 className="mb-1 text-lg font-semibold text-foreground">New Worktree</h2>
        <p className="mb-4 truncate text-xs text-muted-foreground">{workspaceName}</p>

        <input
          ref={inputRef}
          type="text"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="Branch name"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none"
        />

        {actions.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Run on creation</div>
            <div className="flex flex-wrap gap-2">
              {actions.map((action) => (
                <OptionCard
                  key={action.id}
                  selected={selectedActionIds.has(action.id)}
                  onClick={() => toggleAction(action.id)}
                  icon={<DynamicIcon name={action.icon || '__terminal__'} size={16} />}
                  label={action.name}
                />
              ))}
            </div>
          </div>
        )}

        <div className="mt-4">
          <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Spin up on creation</div>
          <div className="flex flex-wrap gap-2">
            {SPIN_UP_AGENTS.map((agent) => (
              <OptionCard
                key={agent.id}
                selected={spinUp === agent.id}
                onClick={() => setSpinUp(spinUp === agent.id ? null : agent.id)}
                icon={<DynamicIcon name={agent.icon} size={16} />}
                label={agent.label}
              />
            ))}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!branch.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </form>
    </div>
  )
}
