'use client'
import { useRef, useState } from 'react'

/**
 * Swipe-left-to-reveal-a-destructive-action, shared by the sidebar's session and
 * worktree rows and the session overview's cards.
 *
 * The reveal IS the confirmation: nothing is destroyed by the swipe itself, only
 * by a deliberate tap on the action it uncovers. That is why there is no dialog
 * on top — a second confirm over a gesture that already takes two steps reads as
 * distrust, and the swipe is easy to abandon (release short of half and it snaps
 * shut).
 *
 * Lives here rather than in either component so the two surfaces cannot drift
 * apart on the details that make the gesture feel like one thing: the same
 * travel, the same halfway commit, the same "a tap on an open row closes it
 * instead of activating it".
 */

/** Width of the action revealed behind a row, and the row's open offset. */
export const REVEAL_PX = 64

/** Finger travel (px) after which a touch counts as a drag, not a tap. */
const TAP_SLOP_PX = 6

export interface SwipeToReveal {
  /** Current horizontal offset of the row, in px (0 to -REVEAL_PX). */
  dx: number
  /** Whether the row is settled open. */
  open: boolean
  /** Whether a finger is currently driving it (drives the CSS transition). */
  dragging: boolean
  /** Set while the touch has travelled far enough to be a drag rather than a tap. */
  moved: React.MutableRefObject<boolean>
  /** Whether to mount the revealed action at all. */
  revealed: boolean
  close: () => void
  touch: {
    onTouchStart: (e: React.TouchEvent) => void
    onTouchMove: (e: React.TouchEvent) => void
    onTouchEnd: () => void
    onTouchCancel: () => void
  }
}

/** When `enabled` is false the row does not swipe (e.g. the main repo can't be deleted). */
export function useSwipeToReveal(enabled: boolean): SwipeToReveal {
  const [dx, setDx] = useState(0)
  const [open, setOpen] = useState(false)
  // While dragging, the row tracks the finger with no transition; on release the
  // snap (open/closed) animates. `dragging` drives that, `start` holds the origin.
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; base: number } | null>(null)
  const moved = useRef(false)

  const clamp = (v: number) => Math.max(-REVEAL_PX, Math.min(0, v))

  const onTouchStart = (e: React.TouchEvent) => {
    if (!enabled) return
    start.current = { x: e.touches[0].clientX, base: dx }
    moved.current = false
    setDragging(true)
  }
  const onTouchMove = (e: React.TouchEvent) => {
    if (!start.current) return
    const delta = e.touches[0].clientX - start.current.x
    if (Math.abs(delta) > TAP_SLOP_PX) moved.current = true
    setDx(clamp(start.current.base + delta))
  }
  const onTouchEnd = () => {
    start.current = null
    setDragging(false)
    const willOpen = dx < -REVEAL_PX / 2
    setOpen(willOpen)
    setDx(willOpen ? -REVEAL_PX : 0)
  }
  const onTouchCancel = () => {
    start.current = null
    setDragging(false)
    setOpen(false)
    setDx(0)
  }

  const close = () => {
    setOpen(false)
    setDx(0)
  }

  // The destructive action sits behind the row; mount it only while the row is
  // actually swiped or being dragged so it can never bleed at the right edge.
  const revealed = enabled && (dragging || dx < 0)

  return {
    dx,
    open,
    dragging,
    moved,
    revealed,
    close,
    touch: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel },
  }
}
