'use client'
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Loader2, Search, Star } from 'lucide-react'
import type { NativeChatModel, NativeChatProvider } from '../../../desktop/src/shared/native-chat'
import {
  NATIVE_CHAT_CATALOG,
  NATIVE_CHAT_PROVIDER_NAMES,
  nativeChatEffortLabel,
} from '../../../desktop/src/shared/native-chat-catalog'
import { cn } from './cn'
import { AnchoredPopover } from './Popover'
import { ProviderIcon } from './ProviderIcon'

// Port of t3code's composer model controls (MIT): ProviderModelPicker's pill,
// ModelPickerContent (provider sidebar + searchable list), ModelPickerSidebar,
// ModelListRow, and the TraitsPicker effort menu. Only Claude, Codex and Cursor
// exist here. A conversation's provider is fixed — the others render locked,
// exactly like t3code's locked-provider mode for a started thread.
//
// Selecting applies immediately (no Apply step). Both controls are memo'd
// behind primitive props + stable callbacks: the pane re-renders while an
// agent streams, and on iOS a row rebuilt between touchstart and touchend
// never fires its click.

const PROVIDERS: NativeChatProvider[] = ['claude', 'codex', 'cursor']
const FAVORITES_KEY = 'orchestra.chat.modelFavorites'

function loadFavorites(): string[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(FAVORITES_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function saveFavorites(favorites: string[]): void {
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites))
  } catch {
    // Storage blocked — favorites just don't persist.
  }
}

const favoriteKey = (provider: NativeChatProvider, id: string) => `${provider}:${id}`

/** t3code's locked-provider tooltip: the conversation's provider can't change. */
function lockedReason(provider: NativeChatProvider): string {
  return `${NATIVE_CHAT_PROVIDER_NAMES[provider]} is unavailable in this conversation. Start a new session to switch providers.`
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
      className="flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent"
    >
      {children}
      <ChevronDown className="-mx-0.5 size-3 shrink-0 opacity-70" />
    </button>
  )
}

// ── ModelListRow ─────────────────────────────────────────────────────────────

const ModelListRow = memo(function ModelListRow({
  provider,
  model,
  selected,
  highlighted,
  favorite,
  disabledReason,
  onSelect,
  onToggleFavorite,
  onHover,
}: {
  provider: NativeChatProvider
  model: NativeChatModel
  selected: boolean
  highlighted: boolean
  favorite: boolean
  disabledReason: string | null
  onSelect: (provider: NativeChatProvider, id: string) => void
  onToggleFavorite: (provider: NativeChatProvider, id: string) => void
  onHover: (key: string) => void
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={disabledReason ? true : undefined}
      title={disabledReason ?? undefined}
      data-highlighted={highlighted || undefined}
      onPointerEnter={() => onHover(favoriteKey(provider, model.id))}
      onClick={() => {
        if (!disabledReason) onSelect(provider, model.id)
      }}
      className={cn(
        'group relative flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5',
        disabledReason ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        highlighted && !disabledReason && 'bg-surface-hover',
      )}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 truncate text-xs font-medium leading-snug text-foreground">{model.label}</div>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <ProviderIcon provider={provider} size={12} className="shrink-0" />
          <span className="truncate text-xs leading-snug text-muted-foreground/70">
            {NATIVE_CHAT_PROVIDER_NAMES[provider]}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {selected && <Check className="size-3.5 text-foreground" aria-hidden />}
        <button
          type="button"
          disabled={Boolean(disabledReason)}
          aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
          title={favorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite(provider, model.id)
          }}
          className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-surface-hover hover:text-foreground disabled:pointer-events-none"
        >
          <Star className={cn('size-3', favorite && 'fill-current text-warning')} />
        </button>
      </div>
    </div>
  )
})

// ── ModelPickerSidebar ───────────────────────────────────────────────────────

type RailSelection = NativeChatProvider | 'favorites'

function ModelPickerSidebar({
  active,
  selected,
  onSelect,
}: {
  active: NativeChatProvider
  selected: RailSelection
  onSelect: (value: RailSelection) => void
}) {
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [indicatorTop, setIndicatorTop] = useState<number | null>(null)
  useLayoutEffect(() => {
    const item = contentRef.current?.querySelector<HTMLElement>(`[data-rail="${selected}"]`)
    setIndicatorTop(item ? item.offsetTop + item.offsetHeight / 2 - 10 : null)
  }, [selected])

  const railButton = (value: RailSelection, label: string, icon: ReactNode, disabledReason: string | null) => (
    <div key={value} className="relative w-full" data-rail={value}>
      <button
        type="button"
        aria-label={disabledReason ?? label}
        aria-pressed={selected === value}
        title={disabledReason ?? label}
        disabled={Boolean(disabledReason)}
        onClick={() => onSelect(value)}
        className={cn(
          'relative flex aspect-square w-full cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none',
          disabledReason && 'cursor-not-allowed opacity-50 hover:bg-transparent',
          selected === value && 'bg-foreground/[0.06]',
        )}
      >
        {icon}
      </button>
    </div>
  )

  return (
    <div className="w-11 shrink-0 overflow-hidden bg-muted/30" aria-label="Providers" role="toolbar" aria-orientation="vertical">
      <div className="h-full overflow-y-auto overscroll-contain [scrollbar-width:none]">
        <div ref={contentRef} className="relative flex min-h-full flex-col gap-1 p-1">
          {indicatorTop !== null && (
            <div
              className="pointer-events-none absolute right-0 z-10 h-5 w-[3px] rounded-l-full bg-primary transition-[top] duration-200 ease-out"
              style={{ top: indicatorTop }}
            />
          )}
          {railButton('favorites', 'Favorites', <Star className="size-5 shrink-0 fill-current" aria-hidden />, null)}
          <div className="border-b border-border/70" aria-hidden />
          {PROVIDERS.map((p) =>
            railButton(
              p,
              NATIVE_CHAT_PROVIDER_NAMES[p],
              <ProviderIcon provider={p} size={20} />,
              p === active ? null : lockedReason(p),
            ),
          )}
        </div>
      </div>
    </div>
  )
}

// ── ModelPickerContent ───────────────────────────────────────────────────────

function ModelPickerContent({
  provider,
  models,
  currentModel,
  onSelect,
}: {
  provider: NativeChatProvider
  models: NativeChatModel[]
  currentModel?: string
  onSelect: (id: string) => void
}) {
  const [favorites, setFavorites] = useState<string[]>(loadFavorites)
  const [query, setQuery] = useState('')
  const [rail, setRail] = useState<RailSelection>(() =>
    favorites.some((f) => f.startsWith(`${provider}:`)) ? 'favorites' : provider,
  )
  const [highlight, setHighlight] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  useLayoutEffect(() => {
    // Desktop keyboards land in the search box; a phone keeps its keyboard
    // down until the reader actually taps the field.
    if (window.matchMedia?.('(pointer: fine)').matches) searchRef.current?.focus({ preventScroll: true })
  }, [])

  const rows = useMemo(() => {
    const all = PROVIDERS.flatMap((p) =>
      (p === provider ? models : NATIVE_CHAT_CATALOG[p]).map((model) => ({ provider: p, model })),
    )
    const q = query.trim().toLowerCase()
    if (q) {
      return all.filter(({ provider: p, model }) =>
        `${model.label} ${model.id} ${NATIVE_CHAT_PROVIDER_NAMES[p]}`.toLowerCase().includes(q),
      )
    }
    if (rail === 'favorites') return all.filter(({ provider: p, model }) => favorites.includes(favoriteKey(p, model.id)))
    return all.filter(({ provider: p }) => p === rail)
  }, [provider, models, query, rail, favorites])

  const selectable = rows.filter((r) => r.provider === provider)
  const highlighted =
    highlight && selectable.some((r) => favoriteKey(r.provider, r.model.id) === highlight)
      ? highlight
      : selectable[0]
        ? favoriteKey(selectable[0].provider, selectable[0].model.id)
        : null

  const toggleFavorite = useCallback((p: NativeChatProvider, id: string) => {
    setFavorites((prev) => {
      const key = favoriteKey(p, id)
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
      saveFavorites(next)
      return next
    })
  }, [])
  const pick = useCallback((p: NativeChatProvider, id: string) => {
    if (p === provider) onSelect(id)
  }, [provider, onSelect])

  const moveHighlight = (delta: number) => {
    if (selectable.length === 0) return
    const index = selectable.findIndex((r) => favoriteKey(r.provider, r.model.id) === highlighted)
    const next = selectable[(index + delta + selectable.length) % selectable.length]
    setHighlight(favoriteKey(next.provider, next.model.id))
  }

  return (
    <div className="relative flex h-[21.625rem] max-h-full w-full flex-row overflow-hidden">
      <ModelPickerSidebar
        active={provider}
        selected={rail}
        onSelect={(value) => {
          setRail(value)
          setQuery('')
        }}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l border-border/70 bg-muted/40">
        <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground/70" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                moveHighlight(e.key === 'ArrowDown' ? 1 : -1)
              } else if (e.key === 'Enter' && highlighted) {
                e.preventDefault()
                const row = selectable.find((r) => favoriteKey(r.provider, r.model.id) === highlighted)
                if (row) pick(row.provider, row.model.id)
              }
              e.stopPropagation()
            }}
            placeholder="Search models..."
            aria-label="Search models"
            // 16px on touch: anything smaller makes iOS zoom the page on focus.
            className="w-full bg-transparent text-[16px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/70 sm:text-sm"
          />
        </div>
        <div role="listbox" className="slim-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-y-contain py-1.5 pl-2 pr-1">
          {rows.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {rail === 'favorites' && !query.trim() ? 'No favorites yet — star a model' : 'No models found'}
            </div>
          ) : (
            rows.map(({ provider: p, model }) => {
              const key = favoriteKey(p, model.id)
              return (
                <ModelListRow
                  key={key}
                  provider={p}
                  model={model}
                  selected={p === provider && model.id === currentModel}
                  highlighted={key === highlighted}
                  favorite={favorites.includes(key)}
                  disabledReason={p === provider ? null : lockedReason(p)}
                  onSelect={pick}
                  onToggleFavorite={toggleFavorite}
                  onHover={setHighlight}
                />
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

// ── Public controls ──────────────────────────────────────────────────────────

export const ModelPickerControl = memo(function ModelPickerControl({
  provider,
  models,
  currentModel,
  busy,
  disabled,
  onSelectModel,
}: {
  provider: NativeChatProvider
  models: NativeChatModel[]
  currentModel?: string
  busy: boolean
  disabled: boolean
  onSelectModel: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement | null>(null)
  const close = useCallback(() => setOpen(false), [])
  const select = useCallback(
    (id: string) => {
      setOpen(false)
      onSelectModel(id)
    },
    [onSelectModel],
  )
  const label = models.find((m) => m.id === currentModel)?.label ?? currentModel ?? 'Default model'
  return (
    <div ref={triggerRef} className="flex min-w-0">
      <ControlPill onOpen={() => setOpen(true)} disabled={disabled} label="Change model">
        <ProviderIcon provider={provider} size={14} className="shrink-0" />
        {busy ? (
          <span className="flex items-center gap-1">
            <Loader2 className="size-3 animate-spin" /> Switching…
          </span>
        ) : (
          <span className="min-w-0 max-w-40 truncate">{label}</span>
        )}
      </ControlPill>
      {open && triggerRef.current && (
        <AnchoredPopover anchor={triggerRef.current} width={360} onClose={close}>
          <ModelPickerContent provider={provider} models={models} currentModel={currentModel} onSelect={select} />
        </AnchoredPopover>
      )}
    </div>
  )
})

export const EffortControl = memo(function EffortControl({
  efforts,
  currentEffort,
  disabled,
  onSelectEffort,
}: {
  efforts: string[]
  currentEffort?: string
  disabled: boolean
  onSelectEffort: (effort: string) => void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement | null>(null)
  const close = useCallback(() => setOpen(false), [])
  if (efforts.length === 0) return null
  return (
    <div ref={triggerRef} className="shrink-0">
      <ControlPill onOpen={() => setOpen(true)} disabled={disabled} label="Change reasoning effort">
        <span className="max-w-24 truncate">{currentEffort ? nativeChatEffortLabel(currentEffort) : 'Effort'}</span>
      </ControlPill>
      {open && triggerRef.current && (
        <AnchoredPopover anchor={triggerRef.current} width={208} onClose={close}>
          <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto p-1" role="radiogroup" aria-label="Reasoning">
            <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">Reasoning</div>
            {efforts.map((effort) => (
              <button
                key={effort}
                type="button"
                role="radio"
                aria-checked={effort === currentEffort}
                onClick={() => {
                  setOpen(false)
                  if (effort !== currentEffort) onSelectEffort(effort)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-surface-hover"
              >
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  {effort === currentEffort && <Check className="size-3.5" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{nativeChatEffortLabel(effort)}</span>
              </button>
            ))}
          </div>
        </AnchoredPopover>
      )}
    </div>
  )
})
