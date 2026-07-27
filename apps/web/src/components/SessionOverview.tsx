'use client'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { DynamicIcon, sessionIconToken } from './DynamicIcon'
import { AgentIconMorph } from './AgentIconMorph'
import { BranchGlyph } from './BranchGlyph'
import { TrashIcon } from './TrashIcon'
import { isLightColor, textColor } from '@/lib/workspace-color'
import { useNow } from '@/hooks/use-now'
import { useSwipeToReveal } from '@/hooks/useSwipeToReveal'
import {
  buildOverview,
  formatAgo,
  formatTokens,
  isAgentSession,
  type OverviewItem,
} from '@/lib/session-overview'
import { classifyTwoFinger, overviewCommit, type RollItem } from '@/lib/session-roll'

/**
 * Every mirrored session on one screen, working first and newest first — the
 * phone's answer to "what's running right now".
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

/**
 * The card's own foreground, and the same at partial strength for secondary text.
 *
 * Each card is painted in its workspace's color, so "white at 50%" is no longer a
 * safe default — a pale workspace would wash every label off its own card. Every
 * ink on a card comes from here instead, flipping to black over light colors the
 * way the desktop chrome does (see chromeVars).
 */
function inkOf(color: string | null) {
  const light = color ? isLightColor(color) : false
  return {
    light,
    fg: color ? textColor(color) : '#ffffff',
    /** Foreground at partial strength — for muted text, hairlines and overlays. */
    soft: (alpha: number) => (light ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha})`),
  }
}

function contextBarColor(percent: number, light: boolean): string {
  if (percent >= CONTEXT_FULL_PCT) return light ? '#b91c1c' : '#f87171'
  if (percent >= CONTEXT_WARN_PCT) return light ? '#b45309' : '#fbbf24'
  return light ? '#15803d' : '#4ade80'
}

/**
 * What a session is doing, in the desktop sidebar's vocabulary rather than a
 * written-out status line: the icon blooms into a pulsing dot field while an
 * agent works, the whole icon hops when the session wants you, and a badge in
 * its corner says which kind of wanting (amber to reply, blue to approve).
 * Idle is simply the absence of all three — the resting icon, as on the Mac.
 *
 * Only "exited" keeps words, because nothing in the icon says a session is over
 * and the card's dimming alone reads as "old" rather than "gone".
 */
function cardState(item: OverviewItem) {
  const exited = Boolean(item.status?.exited)
  const attention = exited ? undefined : item.status?.attention
  return {
    exited,
    attention,
    working: !exited && item.status?.work === 'working',
    /** Badge color, matching the desktop's amber-reply / blue-approval pair. */
    badge: attention ? (attention === 'approval' ? '#60a5fa' : '#f6c453') : null,
    hint: attention === 'approval' ? 'Waiting for approval' : attention ? 'Waiting for you' : undefined,
  }
}

function ContextBar({ item, ink }: { item: OverviewItem; ink: ReturnType<typeof inkOf> }) {
  // Agents only, and only once one has taken a turn — a window that hasn't been
  // measured yet is left blank rather than drawn as an empty (i.e. wrong) bar.
  if (!isAgentSession(item.processStatus)) return null
  if (!item.context) {
    return (
      <div className="text-[11px] tabular-nums" style={{ color: ink.soft(0.4) }}>
        {item.status?.exited ? 'context released' : 'context pending…'}
      </div>
    )
  }
  const { usedTokens, contextWindow, percent } = item.context
  const color = contextBarColor(percent, ink.light)
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full"
        style={{ backgroundColor: ink.soft(0.18) }}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Context window used"
      >
        <div className="h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: color }} />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums" style={{ color: ink.soft(0.65) }}>
        {formatTokens(usedTokens)}/{formatTokens(contextWindow)}
      </span>
      <span className="shrink-0 text-[11px] font-medium tabular-nums" style={{ color }}>
        {percent}%
      </span>
    </div>
  )
}

/**
 * One card, and the kill hiding behind it.
 *
 * Swiping left uncovers a bin; tapping the bin is what actually kills the PTY.
 * The two steps ARE the confirmation — the same bargain the sidebar's rows
 * strike (see useSwipeToReveal) — so there is no dialog on top of it. Releasing
 * short of halfway snaps the card shut, and a tap on an open card closes it
 * rather than opening the session, so the gesture is easy to back out of and
 * hard to complete by accident.
 */
function OverviewCard({
  item,
  now,
  onSelect,
  onCloseSession,
}: {
  item: OverviewItem
  now: number
  onSelect: (sessionId: string) => void
  onCloseSession: ((sessionId: string) => void) | null
}) {
  const swipe = useSwipeToReveal(!!onCloseSession)
  const color = item.color ?? null
  const ink = inkOf(color)
  const state = cardState(item)
  const isAgent = isAgentSession(item.processStatus)
  const iconName = sessionIconToken(item.processStatus, item.actionIcon)
  const ago = formatAgo(item.activeAt, now)

  // A swipe is not a tap: an open card's tap snaps it shut, and a drag that
  // ended up back at rest must not open the session it was dragging.
  const handleClick = () => {
    if (swipe.open) {
      swipe.close()
      return
    }
    if (swipe.moved.current) return
    onSelect(item.sessionId)
  }

  return (
    <div className="relative overflow-hidden rounded-2xl">
      {/* Mounted only while the card is actually swiped, so it can never bleed
          past the right edge of a card sitting at rest. */}
      {swipe.revealed && (
        <button
          type="button"
          aria-label={`Kill ${item.label}`}
          tabIndex={swipe.open ? 0 : -1}
          onClick={() => {
            swipe.close()
            onCloseSession?.(item.sessionId)
          }}
          className="absolute inset-y-0 right-0 flex w-16 items-center justify-center bg-destructive text-white"
        >
          <TrashIcon size={18} />
        </button>
      )}
      {/* The offset lives on this wrapper rather than the card so the card keeps
          its own press feedback — an inline transform here would override the
          `active:scale` class there. */}
      <div
        style={{
          transform: `translateX(${swipe.dx}px)`,
          transition: swipe.dragging ? 'none' : 'transform 0.2s ease',
        }}
        onTouchStart={swipe.touch.onTouchStart}
        onTouchMove={swipe.touch.onTouchMove}
        onTouchEnd={swipe.touch.onTouchEnd}
        onTouchCancel={swipe.touch.onTouchCancel}
      >
    <button
      type="button"
      onClick={handleClick}
      aria-current={item.current || undefined}
      className={cn(
        'relative flex w-full items-start gap-3 overflow-hidden rounded-2xl p-3 text-left',
        'transition-transform active:scale-[0.98]',
        item.status?.exited && 'opacity-55',
      )}
      style={{
        // The card *is* the workspace, painted in its full color against a black
        // screen — the same tinting the desktop gives its chrome, so a glance down
        // the list groups by workspace before you have read a single label.
        backgroundColor: color ?? 'rgba(255,255,255,0.07)',
        color: ink.fg,
        // Whose card is open reads off the ring; the color is spoken for now, so
        // it is the card's own foreground that draws it.
        boxShadow: item.current ? `inset 0 0 0 2px ${ink.fg}` : `inset 0 0 0 1px ${ink.soft(0.12)}`,
      }}
    >
      <span
        className={cn(
          'relative mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl',
          state.attention && 'animate-session-attention',
        )}
        style={{ backgroundColor: ink.soft(0.16) }}
        title={state.hint}
      >
        {isAgent ? (
          <AgentIconMorph icon={iconName} size={18} color={ink.fg} working={state.working} />
        ) : (
          <DynamicIcon name={iconName} size={18} color={ink.fg} />
        )}
        {state.badge && (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full"
            // Ringed in the card's own color so the badge stays legible on a
            // workspace whose color it happens to sit near.
            style={{ backgroundColor: state.badge, boxShadow: `0 0 0 2px ${color ?? '#000000'}` }}
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm font-semibold leading-snug',
              // Same sweep the desktop sidebar runs on a working session's label.
              state.working && 'shimmer-active',
            )}
          >
            {item.label}
          </span>
          {ago && (
            <span className="shrink-0 text-[11px] tabular-nums" style={{ color: ink.soft(0.5) }}>
              {ago}
            </span>
          )}
        </span>
        {/* The branch is the answer to "which copy of the repo is this?", so it
            carries the card's full ink at label weight; the workspace name behind
            it is already said by the color and steps back. */}
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <BranchGlyph size={13} />
          <span className="truncate font-medium" style={{ color: ink.soft(0.92) }}>
            {item.worktree}
          </span>
          <span aria-hidden style={{ color: ink.soft(0.35) }}>
            ·
          </span>
          <span className="shrink-0 truncate" style={{ color: ink.soft(0.6) }}>
            {item.workspaceEmoji ? `${item.workspaceEmoji} ` : ''}
            {item.workspaceName}
          </span>
        </span>
        {state.exited && (
          <span className="text-[11px]" style={{ color: ink.soft(0.5) }}>
            Exited
          </span>
        )}
        <ContextBar item={item} ink={ink} />
      </span>
    </button>
      </div>
    </div>
  )
}

export function SessionOverview({
  items,
  selectedId,
  onSelect,
  onCloseSession,
  onDismiss,
}: {
  /** Every mirrored session, in the roll's running order (see flattenRoll). */
  items: RollItem[]
  selectedId: string | null
  onSelect: (sessionId: string) => void
  /**
   * Kill an agent from its card: swipe left, tap the bin. Null disables the
   * gesture entirely, so the cards don't swipe at all.
   */
  onCloseSession: ((sessionId: string) => void) | null
  /**
   * Zoom back into the session that is still attached underneath, or null when
   * there is none — with nothing open this screen is the whole app, and there is
   * nowhere to be dismissed to.
   */
  onDismiss: (() => void) | null
}) {
  const now = useNow(30_000)
  const cards = buildOverview(items, selectedId, now)
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
      // Plain black: the cards carry every color on this screen, and any tint
      // behind them would sit under one workspace's card and fight it.
      className="h-full overflow-y-auto overscroll-contain"
      style={{ backgroundColor: '#000000' }}
    >
      {cards.length === 0 ? (
        <p className="p-4 text-sm text-white/50">
          No agents running. Start one from the sidebar — or resume a past one below.
        </p>
      ) : (
        <div className="flex flex-col gap-2 p-3 pb-6">
          <p className="px-1 pb-1 text-[11px] uppercase tracking-[0.08em] text-white/35">
            {cards.length} agent{cards.length === 1 ? '' : 's'}
            {running > 0 ? ` · ${running} working` : ''}
            {onDismiss ? ' · pinch out to go back' : ''}
          </p>
          {cards.map((card) => (
            <OverviewCard
              key={card.sessionId}
              item={card}
              now={now}
              onSelect={onSelect}
              onCloseSession={onCloseSession}
            />
          ))}
        </div>
      )}
    </div>
  )
}
