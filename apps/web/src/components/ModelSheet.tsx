'use client'
import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  CODEX_EFFORTS,
  CODEX_MODELS,
  type AgentKind,
  type ModelOption,
} from '../lib/chat-messages'

function catalog(agent: AgentKind): { models: ModelOption[]; efforts: ModelOption[] } {
  return agent === 'claude'
    ? { models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS }
    : { models: CODEX_MODELS, efforts: CODEX_EFFORTS }
}

/** Display label for a stored option value (falls back to the raw value). */
export function modelOptionLabel(
  agent: AgentKind,
  kind: 'model' | 'effort',
  value?: string,
): string {
  if (!value) return ''
  const { models, efforts } = catalog(agent)
  const list = kind === 'model' ? models : efforts
  return list.find((o) => o.value === value)?.label ?? value
}

/**
 * Bottom-sheet picker for a live agent session's model + reasoning effort.
 * Pure selection UI — applying is the caller's job (it types the switch into
 * the desktop TUI over the keystroke pipe). Codex's TUI picker sets model and
 * effort in one flow, so both must be chosen there; claude's /model and
 * /effort are independent commands, so either alone is applicable.
 */
export function ModelSheet({
  agent,
  initial,
  onApply,
  onClose,
}: {
  agent: AgentKind
  initial: { model?: string; effort?: string }
  onApply: (model?: string, effort?: string) => void
  onClose: () => void
}) {
  const { models, efforts } = catalog(agent)
  const [model, setModel] = useState<string | undefined>(initial.model)
  const [effort, setEffort] = useState<string | undefined>(initial.effort)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const canApply = agent === 'codex' ? !!model && !!effort : !!model || !!effort

  const Row = ({
    option,
    selected,
    onSelect,
  }: {
    option: ModelOption
    selected: boolean
    onSelect: () => void
  }) => (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-foreground active:bg-accent',
        selected && 'bg-foreground/10',
      )}
    >
      <span className="flex-1 truncate">{option.label}</span>
      {option.hint && (
        <span className="shrink-0 text-[11px] text-muted-foreground">{option.hint}</span>
      )}
      <span className="flex w-4 shrink-0 justify-end">
        {selected && <Check className="size-3.5" />}
      </span>
    </button>
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80svh] w-full overflow-y-auto rounded-t-2xl border border-border bg-sidebar p-3 shadow-2xl sm:max-w-sm sm:rounded-2xl"
      >
        <div className="mb-1 px-3 pt-1 text-xs uppercase tracking-wider text-muted-foreground">
          Model
        </div>
        {models.map((o) => (
          <Row
            key={o.value}
            option={o}
            selected={model === o.value}
            onSelect={() => setModel((cur) => (agent === 'claude' && cur === o.value ? undefined : o.value))}
          />
        ))}
        <div className="mb-1 mt-3 px-3 text-xs uppercase tracking-wider text-muted-foreground">
          Reasoning effort
        </div>
        {efforts.map((o) => (
          <Row
            key={o.value}
            option={o}
            selected={effort === o.value}
            onSelect={() => setEffort((cur) => (agent === 'claude' && cur === o.value ? undefined : o.value))}
          />
        ))}
        {agent === 'claude' && (
          <p className="mt-2 px-3 text-[11px] text-muted-foreground">
            Applies to this session and becomes the default for new ones.
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-border px-3 py-2.5 text-center text-sm text-muted-foreground active:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canApply}
            onClick={() => onApply(model, effort)}
            className="flex-1 rounded-lg bg-foreground px-3 py-2.5 text-center text-sm font-medium text-background disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}
