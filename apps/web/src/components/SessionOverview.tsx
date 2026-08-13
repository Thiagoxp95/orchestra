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
  buildWorkspacePills,
  formatAgo,
  formatTokens,
  isAgentSession,
  type OverviewItem,
  type OverviewPill,
  type PillWorkspace,
} from '@/lib/session-overview'
import { classifyTwoFinger, overviewCommit, type RollItem } from '@/lib/session-roll'

/**
 * Every mirrored session on one screen, most urgent first — the phone's answer
 * to "what's running right now, and which of it wants me".
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
 *
 * The cards are one flat list in urgency order (see rank), not sectioned by
 * workspace: with sections, a workspace holding one blocked agent could sit
 * below one holding three idle sessions, and the single question you had to
 * answer was buried halfway down the screen. The workspaces keep their own row
 * of pills above the list, where they do the job the section headers were
 * actually being used for — starting something new.
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
  const working = !exited && item.status?.work === 'working'
  return {
    exited,
    attention,
    working,
    /**
     * Nothing is happening and nothing is being asked of you — the resting state.
     * Full color on this screen is reserved for the cards that want something
     * from you now (working, or waiting on your reply), so idle steps back a
     * stop; see the opacity on the card below.
     */
    idle: !exited && !working && !attention,
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
        'transition-[transform,opacity] active:scale-[0.98]',
        // Loudness by demand: the cards that are working or waiting on you keep
        // their workspace color at full strength, an idle session recedes, and a
        // dead one recedes furthest. Scanning the screen then answers "who needs
        // me?" before you have read a single label.
        state.exited ? 'opacity-55' : state.idle && 'opacity-70',
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
            carries the card's full ink at label weight; the workspace is already
            said twice over — by the card's color and by the section header. */}
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <BranchGlyph size={13} />
          <span className="truncate font-medium" style={{ color: ink.soft(0.92) }}>
            {item.worktree}
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

/**
 * The workspaces, as a row of chips above the list — tap one to start something
 * in it.
 *
 * This is the section headers' old job, kept: the header was already a "+"
 * button (it was the only thing on this screen you could act on that wasn't
 * already a session), and it could only ever appear where a session already
 * existed. As a pill row it covers the empty workspaces too, which are exactly
 * the ones you reach for this control to fill.
 *
 * Each pill carries its workspace's color so the row reads as the same key the
 * cards are painted in, and a dot when something in there is asking for you —
 * so a workspace scrolled out of the list still says it has something waiting.
 */
function WorkspacePill({
  pill,
  onOpen,
}: {
  pill: OverviewPill
  onOpen: ((workspaceId: string) => void) | null
}) {
  const color = pill.color
  const body = (
    <>
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color ?? 'rgba(255,255,255,0.35)' }}
      />
      <span className="max-w-32 truncate">
        {pill.emoji} {pill.name}
      </span>
      {pill.live > 0 && (
        <span className="shrink-0 tabular-nums opacity-55">{pill.live}</span>
      )}
      {/* Amber for "something in here is blocked on you", the cards' own badge
          color; a plain count is enough for merely-busy. */}
      {pill.attention && (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[#f6c453]" />
      )}
    </>
  )
  const className = cn(
    'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium',
    'transition-[transform,opacity] active:scale-[0.97]',
  )
  const style = {
    // The color at a fraction of itself: legible against either a black screen
    // or the chrome's own workspace tint, without competing with the cards,
    // which own the full-strength version.
    backgroundColor: color ? `${color}33` : 'rgba(255,255,255,0.07)',
    boxShadow: `inset 0 0 0 1px ${color ? `${color}88` : 'rgba(255,255,255,0.14)'}`,
  }

  if (!onOpen) {
    return (
      <span className={className} style={style}>
        {body}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(pill.workspaceId)}
      title={`Start something in ${pill.name}`}
      className={className}
      style={style}
    >
      {body}
      <span aria-hidden className="shrink-0 pl-0.5 text-sm leading-none opacity-60">
        +
      </span>
    </button>
  )
}

export function SessionOverview({
  items,
  workspaces,
  selectedId,
  onSelect,
  onCloseSession,
  onWorkspaceMenu,
  onDismiss,
}: {
  /** Every mirrored session, in the roll's running order (see flattenRoll). */
  items: RollItem[]
  /**
   * Every workspace, in sidebar order — including the ones with no sessions,
   * which have no card here but still get a pill to start something in.
   */
  workspaces: PillWorkspace[]
  selectedId: string | null
  onSelect: (sessionId: string) => void
  /**
   * Tap a workspace pill to start something in that workspace (see
   * WorkspaceActionSheet). Null leaves the pills as plain labels.
   */
  onWorkspaceMenu: ((workspaceId: string) => void) | null
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
  const pills = buildWorkspacePills(workspaces, cards)
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

  const live = cards.filter((c) => !c.status?.exited)
  const waiting = live.filter((c) => c.status?.attention).length
  const running = live.filter((c) => c.status?.work === 'working').length

  return (
    <div
      ref={hostRef}
      // Same surface as the header above it (SidebarInset's bg-background, tinted
      // per-workspace by chromeVars) — the cards still carry every color; this
      // just keeps the screen from splitting into a gray bar over a black well.
      className="h-full overflow-y-auto overscroll-contain bg-background"
    >
      <div className="flex flex-col gap-3 p-3 pb-6">
        {/* Above the list and above the empty state alike: with nothing running
            this row is the only way out of an empty screen. Scrolls sideways
            rather than wrapping, so a dozen workspaces cost one line. */}
        {pills.length > 0 && (
          <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {pills.map((pill) => (
              <WorkspacePill key={pill.workspaceId} pill={pill} onOpen={onWorkspaceMenu} />
            ))}
          </div>
        )}
        {cards.length === 0 ? (
          <p className="px-1 pt-1 text-sm text-muted-foreground">
            Nothing running. Tap a workspace above to start something — or resume a past session
            below.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="px-1 pb-1 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
              {cards.length} session{cards.length === 1 ? '' : 's'}
              {waiting > 0 ? ` · ${waiting} waiting` : ''}
              {running > 0 ? ` · ${running} working` : ''}
              {onDismiss ? ' · pinch out to go back' : ''}
            </p>
            {/* One flat list, most urgent first. The color still says which
                workspace each card belongs to; the order says what to do next. */}
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
    </div>
  )
}
