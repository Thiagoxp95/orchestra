'use client'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { DynamicIcon, sessionIconToken } from './DynamicIcon'
import { BranchGlyph } from './BranchGlyph'
import { textColor, withAlpha } from '@/lib/workspace-color'
import { DEFAULT_TERMINAL_BG } from '@/lib/terminal-theme'
import { useNow } from '@/hooks/use-now'
import {
  buildOverview,
  formatAgo,
  formatTokens,
  isAgentSession,
  type OverviewItem,
} from '@/lib/session-overview'
import { classifyTwoFinger, overviewCommit, type RollItem } from '@/lib/session-roll'

/**
 * Every mirrored session on one screen, newest work first — the phone's answer
 * to "what's running right now".
 *
 * It is both the empty state (there is nothing else to show with no session
 * open) and the destination of the inward pinch from a live terminal, which is
 * why it never unmounts the session underneath: pinching back out, or tapping
 * the card you came from, has to be instant rather than a fresh attach.
 *
 * The roll next door shows one session at a time and is about *neighbours*; this
 * is about the whole set at once, so it leads with the two things you can't get
 * from a single card — who has been working most recently, and how much context
 * each agent has left before it has to compact.
 */

/** Where a context bar turns from "fine" to "getting full" to "about to compact". */
const CONTEXT_WARN_PCT = 60
const CONTEXT_FULL_PCT = 85

function contextBarColor(percent: number): string {
  if (percent >= CONTEXT_FULL_PCT) return '#f87171'
  if (percent >= CONTEXT_WARN_PCT) return '#fbbf24'
  return '#4ade80'
}

/** The one-line "what is this session doing", matching the roll's cards. */
function cardState(item: OverviewItem): { text: string; tone: string; pulse: boolean } {
  if (item.status?.exited) return { text: 'Exited', tone: 'opacity-40', pulse: false }
  if (item.status?.attention)
    return {
      text: item.status.attention === 'approval' ? 'Waiting for approval' : 'Waiting for you',
      tone: 'text-amber-300',
      pulse: true,
    }
  if (item.status?.work === 'working') return { text: 'Working…', tone: 'text-emerald-300', pulse: true }
  return { text: 'Idle', tone: 'opacity-50', pulse: false }
}

function ContextBar({ item }: { item: OverviewItem }) {
  // Agents only, and only once one has taken a turn — a window that hasn't been
  // measured yet is left blank rather than drawn as an empty (i.e. wrong) bar.
  if (!isAgentSession(item.processStatus)) return null
  if (!item.context) {
    return (
      <div className="text-[11px] tabular-nums opacity-35">
        {item.status?.exited ? 'context released' : 'context pending…'}
      </div>
    )
  }
  const { usedTokens, contextWindow, percent } = item.context
  const color = contextBarColor(percent)
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full"
        style={{ backgroundColor: 'rgba(255,255,255,0.12)' }}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Context window used"
      >
        <div className="h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: color }} />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums opacity-60">
        {formatTokens(usedTokens)}/{formatTokens(contextWindow)}
      </span>
      <span className="shrink-0 text-[11px] font-medium tabular-nums" style={{ color }}>
        {percent}%
      </span>
    </div>
  )
}

function OverviewCard({
  item,
  now,
  onSelect,
}: {
  item: OverviewItem
  now: number
  onSelect: (sessionId: string) => void
}) {
  const color = item.color ?? null
  const state = cardState(item)
  const ago = formatAgo(item.activeAt, now)
  return (
    <button
      type="button"
      onClick={() => onSelect(item.sessionId)}
      aria-current={item.current || undefined}
      className={cn(
        'relative flex w-full items-start gap-3 overflow-hidden rounded-2xl p-3 pl-4 text-left',
        'transition-transform active:scale-[0.98]',
        item.status?.exited && 'opacity-55',
      )}
      style={{
        // The workspace color at a whisper, so a screen spanning every workspace
        // still reads as one list. The accent stripe carries the full color.
        backgroundColor: color ? withAlpha(color, 0.16) : 'rgba(255,255,255,0.05)',
        boxShadow: item.current
          ? `inset 0 0 0 1.5px ${color ?? '#ffffff'}`
          : 'inset 0 0 0 1px rgba(255,255,255,0.07)',
      }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1"
        style={{ backgroundColor: color ?? 'rgba(255,255,255,0.25)' }}
      />
      <span
        className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl"
        style={{ backgroundColor: color ?? 'rgba(255,255,255,0.1)' }}
      >
        <DynamicIcon
          name={sessionIconToken(item.processStatus, item.actionIcon)}
          size={18}
          color={color ? textColor(color) : '#ffffff'}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-snug text-white">
            {item.label}
          </span>
          {ago && <span className="shrink-0 text-[11px] tabular-nums text-white/40">{ago}</span>}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-white/50">
          <BranchGlyph size={11} />
          <span className="truncate">{item.worktree}</span>
          <span aria-hidden className="opacity-40">
            ·
          </span>
          <span className="shrink-0 truncate">
            {item.workspaceEmoji ? `${item.workspaceEmoji} ` : ''}
            {item.workspaceName}
          </span>
        </span>
        <span className={cn('flex items-center gap-1.5 text-[11px] text-white', state.tone)}>
          <span className={cn('size-1.5 rounded-full bg-current', state.pulse && 'animate-pulse')} />
          {state.text}
        </span>
        <ContextBar item={item} />
      </span>
    </button>
  )
}

export function SessionOverview({
  items,
  selectedId,
  onSelect,
  onDismiss,
}: {
  /** Every mirrored session, in the roll's running order (see flattenRoll). */
  items: RollItem[]
  selectedId: string | null
  onSelect: (sessionId: string) => void
  /**
   * Zoom back into the session that is still attached underneath, or null when
   * there is none — with nothing open this screen is the whole app, and there is
   * nowhere to be dismissed to.
   */
  onDismiss: (() => void) | null
}) {
  const now = useNow(30_000)
  const cards = buildOverview(items, selectedId)
  const hostRef = useRef<HTMLDivElement>(null)

  // The way back out: a pinch *outward* zooms into the session still attached
  // underneath, the exact inverse of the pinch that got here. Registered once
  // (a re-registering listener would drop the gesture mid-pinch), so the current
  // dismiss reaches it through a ref.
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let gesture: { s0: number; t0: number; spent: boolean } | null = null
    const spread = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !onDismissRef.current) {
        gesture = null
        return
      }
      gesture = { s0: spread(e.touches), t0: performance.now(), spent: false }
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!gesture || gesture.spent || e.touches.length !== 2) return
      // Claim it from the first move so the browser doesn't page-zoom the list
      // out from under the gesture.
      if (e.cancelable) e.preventDefault()
      // Same classifier the roll uses, with the sign flipped: this screen is the
      // zoomed-out one, so it is the *outward* pinch that means something here.
      // Running it through classifyTwoFinger keeps a two-finger scroll of the
      // list from being read as a lazy pinch.
      const ds = spread(e.touches) - gesture.s0
      if (classifyTwoFinger(0, 0, ds) !== 'reject') return
      if (!overviewCommit(-ds, performance.now() - gesture.t0)) return
      gesture.spent = true
      navigator.vibrate?.(8)
      onDismissRef.current?.()
    }
    const onTouchEnd = () => {
      gesture = null
    }

    host.addEventListener('touchstart', onTouchStart, { passive: true })
    host.addEventListener('touchmove', onTouchMove, { passive: false })
    host.addEventListener('touchend', onTouchEnd, { passive: true })
    host.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      host.removeEventListener('touchstart', onTouchStart)
      host.removeEventListener('touchmove', onTouchMove)
      host.removeEventListener('touchend', onTouchEnd)
      host.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [])

  const running = cards.filter((c) => c.status?.work === 'working' && !c.status?.exited).length

  return (
    <div
      ref={hostRef}
      className="h-full overflow-y-auto overscroll-contain"
      style={{ backgroundColor: DEFAULT_TERMINAL_BG }}
    >
      {cards.length === 0 ? (
        <p className="p-4 text-sm text-white/50">
          Nothing is running. Start a session from the sidebar — or resume a past one below.
        </p>
      ) : (
        <div className="flex flex-col gap-2 p-3 pb-6">
          <p className="px-1 pb-1 text-[11px] uppercase tracking-[0.08em] text-white/35">
            {cards.length} session{cards.length === 1 ? '' : 's'}
            {running > 0 ? ` · ${running} working` : ''}
            {onDismiss ? ' · pinch out to go back' : ''}
          </p>
          {cards.map((card) => (
            <OverviewCard key={card.sessionId} item={card} now={now} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}
