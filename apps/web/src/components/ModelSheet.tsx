'use client'
import { memo, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
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
 * One option row. Declared at module scope on purpose — as a function defined
 * inside ModelSheet it was a NEW component type on every render, so React tore
 * down and rebuilt all ten buttons each time the pane re-rendered (several
 * times a second while an agent streams). On iOS a node removed between
 * touchstart and touchend never delivers its click, which is exactly what
 * "I have to tap twice for the checkmark to move" was.
 */
const Row = memo(function Row({
  option,
  selected,
  onSelect,
}: {
  option: ModelOption
  selected: boolean
  onSelect: (value: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(option.value)}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-foreground hover:bg-surface-hover active:bg-surface-hover',
        selected && 'bg-primary/12 text-foreground',
      )}
    >
      <span className="flex-1 truncate">{option.label}</span>
      {option.hint && (
        <span className="shrink-0 text-[11px] text-muted-foreground">{option.hint}</span>
      )}
      <span className="flex w-4 shrink-0 justify-end">
        {selected && <Check className="size-3.5 text-primary" />}
      </span>
    </button>
  )
})

/**
 * Bottom-sheet picker for a live agent session's model + reasoning effort.
 * Pure selection UI — applying is the caller's job (it types the switch into
 * the desktop TUI over the keystroke pipe). Codex's TUI picker sets model and
 * effort in one flow, so both must be chosen there; claude's /model and
 * /effort are independent commands, so either alone is applicable.
 *
 * Memoized, and fed primitives plus stable callbacks (see useEventCallback):
 * the sheet's own state is the only thing that should ever repaint it. Left
 * re-rendering with its parent it repainted on every mirror push — two stacked
 * backdrop-filters recomposited over a live terminal, which is what made the
 * picker feel like it was ignoring taps.
 */
export const ModelSheet = memo(function ModelSheet({
  agent,
  initialModel,
  initialEffort,
  onApply,
  onClose,
}: {
  agent: AgentKind
  initialModel?: string
  initialEffort?: string
  onApply: (model?: string, effort?: string) => void
  onClose: () => void
}) {
  const { models, efforts } = catalog(agent)
  const [model, setModel] = useState<string | undefined>(initialModel)
  const [effort, setEffort] = useState<string | undefined>(initialEffort)

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

  // Portalled to <body>, for the same reason ResumeSheet is: this sheet is
  // opened from the pill inside the chat pane, which lives under the session
  // roll's translate3d container — a transform makes that div the containing
  // block for `position: fixed`, so "inset-0" meant the PANE, not the screen.
  // Left in place the sheet was laid out (and hit-tested) against a box that
  // starts below the header and ends at the pane's bottom — under Safari's
  // toolbar on a phone — which is why the Apply row was nowhere to be seen and
  // taps on the rows landed off their painted position.
  return createPortal(
    <div
      // No backdrop blur on the scrim: the panel already carries a
      // backdrop-filter, and two of them stacked over a live terminal made iOS
      // recomposite the whole screen on every repaint — the picker's "lag".
      // touch-manipulation drops the tap delay the rows were paying.
      className="fixed inset-0 z-50 flex touch-manipulation items-end justify-center bg-black/70 sm:items-center"
      onClick={onClose}
    >
      {/* The action row must never scroll out of view: the effort list is taller
          than the sheet on short phones, and a sheet whose Apply button sits
          below the fold reads as broken — only the option lists scroll. Capped
          against the VISUAL viewport (--app-h, published by useAppViewport)
          rather than svh, so browser chrome and the home indicator can't eat
          the bottom of the sheet. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="dropdown-glass surface-grain flex w-full flex-col rounded-t-2xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:max-w-sm sm:rounded-2xl"
        style={{ maxHeight: 'calc(var(--app-h, 100svh) * 0.85)' }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mb-1 px-3 pt-1 text-xs uppercase tracking-wider text-muted-foreground">
          Model
        </div>
        {/* A tap always selects — re-tapping the current row used to clear it, a
            leftover from when applying meant sending every field. The caller now
            diffs against the session's live values and sends only what changed,
            so an unchanged row is already a no-op; deselecting it just made the
            checkmark vanish under the finger and Apply do nothing. */}
        {models.map((o) => (
          <Row
            key={o.value}
            option={o}
            selected={model === o.value}
            onSelect={setModel}
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
            onSelect={setEffort}
          />
        ))}
        {/* Every claude session is launched with `--model opus --effort high`
            (CLAUDE_DEFAULT_MODEL in the desktop's action-utils), and those
            flags are per-session — so a switch here can no longer leak into the
            next session by way of ~/.claude/settings.json. */}
        {agent === 'claude' && (
          <p className="mt-2 px-3 text-[11px] text-muted-foreground">
            Applies to this chat only. New sessions start on Opus · High.
          </p>
        )}
        </div>
        <div className="mt-3 flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-border px-3 py-2.5 text-center text-sm text-muted-foreground active:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canApply}
            onClick={() => onApply(model, effort)}
            className="flex-1 rounded-lg bg-primary px-3 py-2.5 text-center text-sm font-medium text-primary-foreground disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
})
