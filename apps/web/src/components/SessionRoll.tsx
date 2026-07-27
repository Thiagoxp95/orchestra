'use client'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { DynamicIcon, sessionIconToken } from './DynamicIcon'
import { BranchGlyph } from './BranchGlyph'
import { isLightColor, textColor } from '@/lib/workspace-color'
import { DEFAULT_TERMINAL_BG } from '@/lib/terminal-theme'
import { useSidebar } from '@/components/ui/sidebar'
import {
  classifyTwoFinger,
  closeCommit,
  drawerCommit,
  overviewCommit,
  rollCommit,
  rollIndex,
  rollNeighbor,
  ROLL_ANIM_MS,
  type RollItem,
  type RollStatusLike,
} from '@/lib/session-roll'

/**
 * The session roll — swipe up/down with two fingers to cycle through every session
 * the desktop is mirroring, in sidebar order, across workspaces. Horizontally the
 * same two fingers act on the session you're already in: rightward opens the sidebar
 * drawer (the axis it already slides on), leftward closes the session (the direction
 * the sidebar's own swipe-to-trash uses on a row). Pinched inward they pull all the
 * way back to the overview (see SessionOverview) — the same two fingers on a third
 * axis, and the one meaning the gesture already has everywhere else on the phone.
 *
 * Only the attached session is ever a live terminal. Mounting the neighbours as
 * terminals too would mean three simultaneous attaches, three chunk streams and
 * three competing geometry claims over the one shared PTY — so the neighbours are
 * identity cards instead (agent, task label, worktree, workspace tint). On commit
 * the card slides fully into place, the attach happens behind it, and it dissolves
 * into the terminal as the seed paints — which also covers the black frame a fresh
 * TerminalPane shows before its snapshot arrives.
 */

/** How long the committed card sits on screen while the new terminal attaches. */
const COVER_HOLD_MS = 220
/** …and how long it takes to dissolve into the terminal underneath. */
const COVER_FADE_MS = 320

/** The one-line "what is this session doing" under the card's title. */
function cardState(status?: RollStatusLike): { text: string; dot: string; jump: boolean } {
  if (status?.exited) return { text: 'Exited', dot: 'opacity-30', jump: false }
  if (status?.attention)
    return {
      text: status.attention === 'approval' ? 'Waiting for approval' : 'Waiting for you',
      dot: 'animate-pulse',
      jump: true,
    }
  if (status?.work === 'working') return { text: 'Working…', dot: 'animate-pulse', jump: false }
  return { text: 'Idle', dot: 'opacity-40', jump: false }
}

function RollCard({ item, position, total }: { item: RollItem; position: number; total: number }) {
  // Tinted with the workspace color exactly like the chrome (see workspace-color),
  // so thumbing through the roll reads as moving between workspaces, not just rows.
  const bg = item.color ?? DEFAULT_TERMINAL_BG
  const fg = item.color ? textColor(item.color) : '#ffffff'
  const tile = item.color && isLightColor(item.color) ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)'
  const state = cardState(item.status)
  return (
    <div
      className="relative flex h-full w-full select-none flex-col items-center justify-center gap-2.5 overflow-hidden px-8 text-center"
      style={{ backgroundColor: bg, color: fg }}
    >
      <span className="max-w-full truncate text-[11px] font-semibold uppercase tracking-[0.08em] opacity-60">
        {item.workspaceEmoji ? `${item.workspaceEmoji} ` : ''}
        {item.workspaceName}
      </span>
      <span
        className="flex size-14 shrink-0 items-center justify-center rounded-2xl"
        style={{ backgroundColor: tile }}
      >
        <DynamicIcon name={sessionIconToken(item.processStatus, item.actionIcon)} size={28} color={fg} />
      </span>
      <span className="max-w-full truncate text-lg font-semibold leading-tight">{item.label}</span>
      <span className="flex max-w-full items-center gap-1.5 text-sm opacity-70">
        <BranchGlyph />
        <span className="truncate">{item.worktree}</span>
      </span>
      <span className={cn('flex items-center gap-1.5 text-xs opacity-80', state.jump && 'animate-agent-jump')}>
        <span className={cn('size-1.5 rounded-full bg-current', state.dot)} />
        {state.text}
      </span>
      <span className="absolute inset-x-0 bottom-6 text-[11px] tabular-nums opacity-45">
        {position} / {total}
      </span>
    </div>
  )
}

export function SessionRoll({
  items,
  selectedId,
  onSelect,
  onCloseSession,
  onOverview,
  children,
}: {
  /** Every mirrored session, in the roll's running order (see flattenRoll). */
  items: RollItem[]
  selectedId: string | null
  onSelect: (sessionId: string) => void
  /** Leftward two-finger swipe: kill the open session's PTY and close its row. */
  onCloseSession: (sessionId: string) => void
  /** Inward pinch: zoom out to the overview, leaving this session attached. */
  onOverview: () => void
  /** The live terminal for `selectedId`. */
  children: React.ReactNode
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [dy, setDy] = useState(0)
  // Whether the stage animates to its offset. Off while a finger is driving it, and
  // for the one frame where the committed stage is dropped back to the origin.
  const [snap, setSnap] = useState(true)
  // A roll is under way: mount the neighbour cards.
  const [active, setActive] = useState(false)
  // The card left covering the screen while the session it names attaches.
  const [cover, setCover] = useState<RollItem | null>(null)
  const [coverFading, setCoverFading] = useState(false)

  // The touch handlers are registered once (a re-registering listener would drop
  // gestures mid-drag), so current props reach them through refs.
  const itemsRef = useRef(items)
  itemsRef.current = items
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onCloseSessionRef = useRef(onCloseSession)
  onCloseSessionRef.current = onCloseSession
  const onOverviewRef = useRef(onOverview)
  onOverviewRef.current = onOverview
  // Opening the drawer from a gesture rather than a prop: the roll already lives
  // inside the SidebarProvider, and `open` is the provider's state, not the page's.
  const { isMobile, setOpen, setOpenMobile } = useSidebar()
  const openSidebarRef = useRef<() => void>(() => {})
  openSidebarRef.current = () => (isMobile ? setOpenMobile(true) : setOpen(true))
  const dyRef = useRef(0)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => () => timersRef.current.forEach(clearTimeout), [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    // The gesture in flight, or null. `mode` starts 'pending' — a two-finger touch
    // isn't a roll (or a drawer pull) until it has moved far enough to tell it from a
    // pinch (classifyTwoFinger).
    let gesture: {
      x0: number
      y0: number
      s0: number
      t0: number
      mode: 'pending' | 'roll' | 'drawer' | 'close' | 'overview'
    } | null = null
    // Set while the committed card slides in, so a second swipe can't start a roll
    // from a session that is already on its way out.
    let committing = false

    const after = (ms: number, fn: () => void) => {
      const id = setTimeout(() => {
        timersRef.current = timersRef.current.filter((t) => t !== id)
        fn()
      }, ms)
      timersRef.current.push(id)
    }
    const midpoint = (t: TouchList) => ({
      x: (t[0].clientX + t[1].clientX) / 2,
      y: (t[0].clientY + t[1].clientY) / 2,
    })
    const spread = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const setOffset = (v: number) => {
      dyRef.current = v
      setDy(v)
    }
    const snapBack = () => {
      gesture = null
      setSnap(true)
      setOffset(0)
      after(ROLL_ANIM_MS, () => setActive(false))
    }

    const onTouchStart = (e: TouchEvent) => {
      if (committing) return
      // A third finger (or the second lifting) ends whatever was in flight.
      if (e.touches.length !== 2) {
        if (gesture) snapBack()
        return
      }
      const m = midpoint(e.touches)
      gesture = { x0: m.x, y0: m.y, s0: spread(e.touches), t0: performance.now(), mode: 'pending' }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!gesture || e.touches.length !== 2) return
      // Claim the gesture from its very first move. iOS won't cancel a native pan
      // that has already begun, so waiting until the direction is certain would let
      // xterm's scrollback (touch-action: pan-y) scroll under the roll for the first
      // dozen pixels — and then keep scrolling for the rest of the drag.
      if (e.cancelable) e.preventDefault()

      const m = midpoint(e.touches)
      const dx = m.x - gesture.x0
      const raw = m.y - gesture.y0
      const ds = spread(e.touches) - gesture.s0

      if (gesture.mode === 'pending') {
        const verdict = classifyTwoFinger(dx, raw, ds)
        // An outward pinch is not ours: drop the gesture without having touched
        // the stage, so nothing on screen moved for it. A leftward pull with
        // nothing open goes the same way — there is no session to close, and
        // letting it stay pending would let the drag re-classify as a roll
        // halfway through. An inward pinch with nothing open is dropped for the
        // mirror-image reason: the overview is already what's on screen.
        if (
          verdict === 'reject' ||
          ((verdict === 'close' || verdict === 'overview') && !selectedRef.current)
        ) {
          gesture = null
          return
        }
        if (verdict === 'pending') return
        gesture.mode = verdict
        if (verdict === 'roll') {
          setActive(true)
          // Hand the stage to the finger. Batched with the offset below, so the
          // transition is off in the same frame the first offset lands (turning it
          // off a frame early would jump a snap-back animation to its end).
          setSnap(false)
        }
      }

      // Pinched inward: zoom out to the overview. Same shape as the drawer pull
      // below — fires mid-gesture, then the gesture is spent — and like the close
      // it re-reads the selection at commit time rather than trusting the one
      // classify saw. Non-destructive, so the session stays attached behind the
      // overview and an outward pinch there brings it straight back.
      if (gesture.mode === 'overview') {
        if (!overviewCommit(ds, performance.now() - gesture.t0)) return
        gesture = null
        if (!selectedRef.current) return
        navigator.vibrate?.(8)
        onOverviewRef.current()
        return
      }

      // A drawer pull leaves the stage alone — the drawer is what moves. It fires the
      // moment the swipe has earned it and then the gesture is spent, so the rest of
      // the drag (and the release) can't fire it twice or start a roll.
      if (gesture.mode === 'drawer') {
        if (!drawerCommit(dx, performance.now() - gesture.t0)) return
        gesture = null
        navigator.vibrate?.(8)
        openSidebarRef.current()
        return
      }

      // Leftward: close the open session. Same shape as the drawer pull — fires
      // mid-drag, spends the gesture — but it kills a PTY, so it re-reads the
      // selection at commit time rather than trusting the one classify saw: the
      // roll can swap sessions underneath a slow drag, and closing whichever
      // session happened to be open when the fingers landed is not what was meant.
      if (gesture.mode === 'close') {
        if (!closeCommit(dx, performance.now() - gesture.t0)) return
        const target = selectedRef.current
        gesture = null
        if (!target) return
        // A longer buzz than the drawer's: this one destroys something, and the
        // only other feedback is the terminal vanishing.
        navigator.vibrate?.(20)
        onCloseSessionRef.current(target)
        return
      }

      const h = host.clientHeight || 1
      const dir: 1 | -1 = raw < 0 ? 1 : -1
      // Nowhere to roll (a single session, or none mirrored): rubber-band rather
      // than dragging a blank card up from below.
      const neighbour = rollNeighbor(itemsRef.current, selectedRef.current, dir)
      setOffset(neighbour ? Math.max(-h, Math.min(h, raw)) : raw * 0.25)
    }

    const onTouchEnd = () => {
      if (!gesture) return
      const wasRoll = gesture.mode === 'roll'
      const elapsed = performance.now() - gesture.t0
      gesture = null
      // Never classified as a roll (a tap, a pinch, a rightward pull that stopped
      // short of the drawer): the stage was never touched, so nothing to put back.
      if (!wasRoll) return
      const h = host.clientHeight || 1
      const dir = rollCommit(dyRef.current, h, elapsed)
      const target = dir ? rollNeighbor(itemsRef.current, selectedRef.current, dir) : null
      if (!dir || !target) {
        snapBack()
        return
      }
      committing = true
      navigator.vibrate?.(8)
      setSnap(true)
      setOffset(dir === 1 ? -h : h)
      after(ROLL_ANIM_MS, () => {
        // The card now fills the screen: swap the attached session behind it, drop
        // the stage back to the origin without animating (the card the user is
        // looking at must not slide away), and let the cover dissolve into the
        // terminal as it seeds.
        committing = false
        onSelectRef.current(target.sessionId)
        setActive(false)
        setSnap(false)
        setOffset(0)
        setCover(target)
        // Two frames: the first paints the origin with no transition, the second
        // re-arms it for the next drag. Skipped if a new gesture already owns it.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (!gesture) setSnap(true)
          }),
        )
      })
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

  // Hold the committed card over the attaching terminal, then dissolve it.
  useEffect(() => {
    if (!cover) return
    setCoverFading(false)
    const hold = setTimeout(() => setCoverFading(true), COVER_HOLD_MS)
    const drop = setTimeout(() => setCover(null), COVER_HOLD_MS + COVER_FADE_MS)
    return () => {
      clearTimeout(hold)
      clearTimeout(drop)
    }
  }, [cover])

  const total = items.length
  const prev = active ? rollNeighbor(items, selectedId, -1) : null
  const next = active ? rollNeighbor(items, selectedId, 1) : null

  return (
    <div ref={hostRef} className="relative h-full overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          transform: `translate3d(0, ${dy}px, 0)`,
          transition: snap ? `transform ${ROLL_ANIM_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)` : 'none',
          willChange: active ? 'transform' : 'auto',
        }}
      >
        <div className="absolute inset-0">{children}</div>
        {prev && (
          <div className="absolute inset-x-0 bottom-full h-full">
            <RollCard item={prev} position={rollIndex(items, prev.sessionId) + 1} total={total} />
          </div>
        )}
        {next && (
          <div className="absolute inset-x-0 top-full h-full">
            <RollCard item={next} position={rollIndex(items, next.sessionId) + 1} total={total} />
          </div>
        )}
      </div>
      {cover && (
        <div
          className="pointer-events-none absolute inset-0 transition-opacity"
          style={{ opacity: coverFading ? 0 : 1, transitionDuration: `${COVER_FADE_MS}ms` }}
        >
          <RollCard item={cover} position={rollIndex(items, cover.sessionId) + 1} total={total} />
        </div>
      )}
    </div>
  )
}
