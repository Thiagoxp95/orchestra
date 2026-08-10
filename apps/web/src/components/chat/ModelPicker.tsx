'use client'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Loader2, Search, Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DynamicIcon } from '../DynamicIcon'
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  CODEX_EFFORTS,
  CODEX_MODELS,
  type AgentKind,
  type ModelOption,
} from '../../lib/chat-messages'

// t3code-style composer controls (github.com/pingdotgg/t3code, MIT): a model
// pill that opens an anchored popover — provider rail, search, tap-to-apply
// rows — and a separate effort pill that opens a radio menu. Selecting applies
// IMMEDIATELY (the caller types the switch into the TUI in the background);
// there is no Apply/Cancel step, which is what made the old bottom sheet feel
// slow. Both controls are memo'd behind primitive props + stable callbacks —
// this pane re-renders several times a second while an agent streams, and on
// iOS a row rebuilt between touchstart and touchend never fires its click.

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

const PROVIDERS: { agent: AgentKind; icon: string; name: string }[] = [
  { agent: 'claude', icon: '__claude__', name: 'Claude Code' },
  { agent: 'codex', icon: '__openai__', name: 'Codex' },
]

function providerMeta(agent: AgentKind): { icon: string; name: string } {
  return PROVIDERS.find((p) => p.agent === agent) ?? PROVIDERS[0]
}

// ── Favorites (localStorage, keyed agent:value like t3code's provider:slug) ──

const FAVORITES_KEY = 'orchestra.modelPicker.favorites'

function loadFavorites(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(FAVORITES_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function favoriteKey(agent: AgentKind, value: string): string {
  return `${agent}:${value}`
}

// ── Anchored popover (hand-rolled: no Base UI here) ──────────────────────────

/**
 * Fixed-position panel anchored ABOVE its trigger (the composer sits at the
 * bottom of the screen). Portalled to <body> — the pill lives under the
 * SessionRoll's translate3d container, and a transform makes that div the
 * containing block for `position: fixed`, so without the portal the panel
 * would be laid out (and hit-tested) against the pane box, not the screen.
 * Same trap ModelSheet and ResumeSheet already document.
 */
function AnchoredPopover({
  anchor,
  width,
  onClose,
  children,
}: {
  anchor: HTMLElement
  width: number
  onClose: () => void
  children: ReactNode
}) {
  const [style, setStyle] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const vw = window.innerWidth
      const w = Math.min(width, vw - 16)
      const left = Math.min(Math.max(rect.left, 8), vw - w - 8)
      setStyle({
        left,
        bottom: window.innerHeight - rect.top + 8,
        width: w,
        // Cap against the visual viewport (--app-h, published by
        // useAppViewport) so browser chrome can't eat the top of the panel.
        maxHeight: `min(21.625rem, calc(var(--app-h, 100svh) - ${window.innerHeight - rect.top + 24}px))`,
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, width])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  if (!style) return null
  return createPortal(
    // Transparent scrim, no backdrop-filter: the panel already carries one,
    // and two stacked over a live terminal recomposite the whole screen per
    // repaint (the old picker's "lag"). touch-manipulation drops the tap delay.
    <div className="fixed inset-0 z-50 touch-manipulation" onPointerDown={onClose}>
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="dropdown-glass surface-grain fixed flex flex-col overflow-hidden rounded-lg border border-border/70 shadow-xl"
        style={style}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

// ── Composer pill (t3code ComposerControl) ───────────────────────────────────

function ControlPill({
  onOpen,
  disabled,
  label,
  children,
}: {
  onOpen: () => void
  disabled: boolean
  label: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      // Keep the soft keyboard up: focus must stay in the composer textarea.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
      disabled={disabled}
      aria-label={label}
      className="flex h-8 min-w-0 items-center gap-1.5 rounded-full border border-border/70 px-2.5 text-[11px] font-medium text-muted-foreground active:bg-surface-hover disabled:opacity-50"
    >
      {children}
      <ChevronDown className="-mx-0.5 size-3 shrink-0 opacity-70" />
    </button>
  )
}

// ── Model picker rows (module scope + memo: see file header) ─────────────────

const ModelRow = memo(function ModelRow({
  agent,
  option,
  selected,
  disabledReason,
  favorite,
  onSelect,
  onToggleFavorite,
}: {
  agent: AgentKind
  option: ModelOption
  selected: boolean
  disabledReason: string | null
  favorite: boolean
  onSelect: (agent: AgentKind, value: string) => void
  onToggleFavorite: (agent: AgentKind, value: string) => void
}) {
  const meta = providerMeta(agent)
  return (
    <div
      title={disabledReason ?? undefined}
      className={cn(
        'group flex w-full items-center gap-3 rounded-md px-2 py-2',
        disabledReason ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-surface-hover',
        selected && 'bg-foreground/8',
      )}
      onClick={() => {
        if (!disabledReason) onSelect(agent, option.value)
      }}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 truncate text-xs font-medium leading-snug text-foreground">
            {option.label}
          </div>
          {selected && <Check className="size-3 shrink-0 text-primary" />}
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <DynamicIcon name={meta.icon} size={11} />
          <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
            {option.hint ? `${meta.name} · ${option.hint}` : meta.name}
          </span>
        </div>
      </div>
      <button
        type="button"
        aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
        className={cn(
          '-mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:text-foreground',
          favorite && 'text-foreground',
        )}
        onClick={(e) => {
          e.stopPropagation()
          onToggleFavorite(agent, option.value)
        }}
      >
        <Star className={cn('size-3.5', favorite && 'fill-current text-yellow-500')} />
      </button>
    </div>
  )
})

type RailSelection = AgentKind | 'favorites'

const RailButton = memo(function RailButton({
  value,
  selected,
  disabledReason,
  onSelect,
  children,
  label,
}: {
  value: RailSelection
  selected: boolean
  disabledReason: string | null
  onSelect: (value: RailSelection) => void
  children: ReactNode
  label: string
}) {
  return (
    <div className="relative w-full">
      <button
        type="button"
        aria-label={label}
        title={disabledReason ?? label}
        disabled={!!disabledReason}
        onClick={() => onSelect(value)}
        className={cn(
          'relative flex aspect-square w-full items-center justify-center rounded-md',
          disabledReason ? 'cursor-not-allowed opacity-50' : 'hover:bg-surface-hover',
          selected && 'bg-foreground/8',
        )}
      >
        {children}
      </button>
      {selected && (
        <div className="pointer-events-none absolute -right-1 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-l-full bg-primary" />
      )}
    </div>
  )
})

// ── Model picker (t3code ProviderModelPicker + ModelPickerContent) ───────────

export const ModelPickerControl = memo(function ModelPickerControl({
  agent,
  currentModel,
  currentEffort,
  busy,
  disabled,
  gateNotice,
  onSelectModel,
  onNotice,
}: {
  agent: AgentKind
  currentModel?: string
  currentEffort?: string
  busy: boolean
  disabled: boolean
  /** Non-null when the session can no longer take a switch (agent gone). */
  gateNotice: string | null
  onSelectModel: (value: string) => void
  onNotice: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [rail, setRail] = useState<RailSelection>(agent)
  const [favorites, setFavorites] = useState<string[]>([])
  const triggerRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  // The popover's mount is gated on the agent being alive. Pair the forced
  // close with words — a picker that closes itself for no visible reason is
  // the same silence as a dropped switch, and it gets reported the same way.
  useEffect(() => {
    if (open && gateNotice) {
      setOpen(false)
      onNotice(gateNotice)
    }
  }, [open, gateNotice, onNotice])

  const openPicker = useCallback(() => {
    const favs = loadFavorites()
    setFavorites(favs)
    setRail(favs.some((f) => f.startsWith(`${agent}:`)) ? 'favorites' : agent)
    setQuery('')
    setOpen(true)
  }, [agent])
  const close = useCallback(() => setOpen(false), [])

  const toggleFavorite = useCallback((favAgent: AgentKind, value: string) => {
    setFavorites((prev) => {
      const key = favoriteKey(favAgent, value)
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
      try {
        window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next))
      } catch {
        // Storage full/blocked — favorites just don't persist.
      }
      return next
    })
  }, [])

  const pick = useCallback(
    (rowAgent: AgentKind, value: string) => {
      setOpen(false)
      if (rowAgent === agent) onSelectModel(value)
    },
    [agent, onSelectModel],
  )

  const selectRail = useCallback((value: RailSelection) => {
    setRail(value)
    searchRef.current?.focus()
  }, [])

  // Rows: searching sweeps every provider (disabled ones stay visible with a
  // reason, like t3code's locked-provider mode); browsing shows the rail's
  // provider, or every favorited model on the favorites rail.
  const rows = useMemo(() => {
    const all = PROVIDERS.flatMap((p) => catalog(p.agent).models.map((m) => ({ agent: p.agent, option: m })))
    const q = query.trim().toLowerCase()
    if (q) {
      return all.filter(({ agent: a, option }) =>
        `${option.label} ${option.hint ?? ''} ${providerMeta(a).name}`.toLowerCase().includes(q),
      )
    }
    if (rail === 'favorites') {
      return all.filter(({ agent: a, option }) => favorites.includes(favoriteKey(a, option.value)))
    }
    return all.filter(({ agent: a }) => a === rail)
  }, [query, rail, favorites])

  const meta = providerMeta(agent)
  const label = [
    modelOptionLabel(agent, 'model', currentModel),
    modelOptionLabel(agent, 'effort', currentEffort),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div ref={triggerRef} className="min-w-0">
      <ControlPill onOpen={openPicker} disabled={disabled} label="Change model">
        <DynamicIcon name={meta.icon} size={12} />
        {busy ? (
          <span className="flex items-center gap-1">
            <Loader2 className="size-3 animate-spin" /> Switching…
          </span>
        ) : (
          <span className="max-w-36 truncate">
            {modelOptionLabel(agent, 'model', currentModel) || (label ? label : 'Model')}
          </span>
        )}
      </ControlPill>
      {open && triggerRef.current && (
        <AnchoredPopover anchor={triggerRef.current} width={340} onClose={close}>
          <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
            {/* Provider rail (hidden while searching, like t3code) */}
            {!query.trim() && (
              <div className="w-11 shrink-0 overflow-y-auto border-r border-border/70 p-1">
                <div className="flex flex-col gap-1">
                  <RailButton
                    value="favorites"
                    selected={rail === 'favorites'}
                    disabledReason={null}
                    onSelect={selectRail}
                    label="Favorites"
                  >
                    <Star className="size-4 fill-current text-muted-foreground" />
                  </RailButton>
                  <div className="border-b border-border/70" aria-hidden />
                  {PROVIDERS.map((p) => (
                    <RailButton
                      key={p.agent}
                      value={p.agent}
                      selected={rail === p.agent}
                      disabledReason={
                        p.agent === agent
                          ? null
                          : `${p.name} is unavailable in this session — this chat runs ${meta.name}.`
                      }
                      onSelect={selectRail}
                      label={p.name}
                    >
                      <DynamicIcon name={p.icon} size={16} />
                    </RailButton>
                  ))}
                </div>
              </div>
            )}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {/* Search */}
              <div className="px-2 pt-2">
                <div className="flex items-center gap-1.5 border-b border-border/70 pb-2">
                  <Search className="size-3.5 shrink-0 text-muted-foreground/70" />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const first = rows.find((r) => r.agent === agent)
                        if (first) pick(first.agent, first.option.value)
                      }
                      e.stopPropagation()
                    }}
                    placeholder="Search models..."
                    // 16px: anything smaller makes iOS zoom the page on focus.
                    className="w-full bg-transparent text-[16px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/70 sm:text-sm"
                  />
                </div>
              </div>
              {/* Model list */}
              <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto p-1.5">
                {rows.length === 0 ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">
                    {rail === 'favorites' && !query.trim()
                      ? 'No favorites yet — tap a star'
                      : 'No models found'}
                  </div>
                ) : (
                  rows.map(({ agent: rowAgent, option }) => (
                    <ModelRow
                      key={`${rowAgent}:${option.value}`}
                      agent={rowAgent}
                      option={option}
                      selected={rowAgent === agent && option.value === currentModel}
                      disabledReason={
                        rowAgent === agent
                          ? null
                          : `Unavailable in this session — this chat runs ${meta.name}.`
                      }
                      favorite={favorites.includes(favoriteKey(rowAgent, option.value))}
                      onSelect={pick}
                      onToggleFavorite={toggleFavorite}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        </AnchoredPopover>
      )}
    </div>
  )
})

// ── Effort menu (t3code TraitsPicker) ────────────────────────────────────────

const EffortRow = memo(function EffortRow({
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
        'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-foreground hover:bg-surface-hover',
        selected && 'bg-foreground/8',
      )}
    >
      <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
      {option.hint && (
        <span className="shrink-0 text-[10px] text-muted-foreground">{option.hint}</span>
      )}
      {selected && <Check className="size-3 shrink-0 text-primary" />}
    </button>
  )
})

export const EffortControl = memo(function EffortControl({
  agent,
  currentEffort,
  disabled,
  gateNotice,
  onSelectEffort,
  onNotice,
}: {
  agent: AgentKind
  currentEffort?: string
  disabled: boolean
  gateNotice: string | null
  onSelectEffort: (value: string) => void
  onNotice: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (open && gateNotice) {
      setOpen(false)
      onNotice(gateNotice)
    }
  }, [open, gateNotice, onNotice])

  const close = useCallback(() => setOpen(false), [])
  const openMenu = useCallback(() => setOpen(true), [])
  const pick = useCallback(
    (value: string) => {
      setOpen(false)
      onSelectEffort(value)
    },
    [onSelectEffort],
  )

  const { efforts } = catalog(agent)

  return (
    <div ref={triggerRef} className="min-w-0">
      <ControlPill onOpen={openMenu} disabled={disabled} label="Change reasoning effort">
        <span className="max-w-24 truncate">
          {modelOptionLabel(agent, 'effort', currentEffort) || 'Effort'}
        </span>
      </ControlPill>
      {open && triggerRef.current && (
        <AnchoredPopover anchor={triggerRef.current} width={224} onClose={close}>
          <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto p-1.5">
            <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
              Reasoning Effort
            </div>
            {efforts.map((o) => (
              <EffortRow
                key={o.value}
                option={o}
                selected={o.value === currentEffort}
                onSelect={pick}
              />
            ))}
            {agent === 'claude' && (
              <p className="px-2 pb-1 pt-2 text-[10px] leading-snug text-muted-foreground/70">
                Applies to this chat only. New sessions start on Opus · High.
              </p>
            )}
          </div>
        </AnchoredPopover>
      )}
    </div>
  )
})
