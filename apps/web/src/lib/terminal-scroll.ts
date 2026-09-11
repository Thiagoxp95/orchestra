// Translating touch swipes into scroll input for a full-screen (alt-buffer) TUI.
//
// The normal terminal buffer has real scrollback, so a swipe scrolls xterm's own
// viewport natively. A full-screen program (Claude Code, vim, htop, less) runs in
// the alternate buffer, which has no scrollback — a swipe there must instead be
// sent to the program as the scroll input it expects.

export interface ScrollModes {
  // The program has DECSET mouse tracking on (it wants pointer/wheel events).
  mouseTracking: boolean
  // Application cursor keys mode (DECCKM) — arrows are sent as ESC O x not ESC [ x.
  applicationCursor: boolean
}

/**
 * Bytes that scroll an alt-buffer TUI by one notch in the given direction.
 *
 * When the program tracks the mouse, emit an SGR wheel report (button 64 = up,
 * 65 = down). Modern TUIs negotiate SGR mouse encoding, so a wheel report scrolls
 * their viewport; the cell coordinate is reported as 1;1 (top-left), which sits
 * inside a full-screen program's scroll region. When the mouse isn't tracked,
 * fall back to arrow keys — this drives pagers (less/man) and is a sane default.
 */
export function altScrollSequence(modes: ScrollModes, up: boolean): string {
  if (modes.mouseTracking) {
    const button = up ? 64 : 65
    return `\x1b[<${button};1;1M`
  }
  if (up) return modes.applicationCursor ? '\x1bOA' : '\x1b[A'
  return modes.applicationCursor ? '\x1bOB' : '\x1b[B'
}

/**
 * Fold a burst of freshly earned notches into the pool waiting to be sent.
 *
 * Every notch that leaves here is a network round trip — the wheel report goes
 * to the desktop, the TUI redraws, and the frame comes back through Convex — so
 * the pool exists to make the number of round trips track how long a swipe
 * lasted rather than how far it travelled. Two rules keep the pool honest:
 *
 * - A reversal empties it. Notches queued in the old direction are scroll the
 *   user has just decided against; sending them anyway makes the screen lurch
 *   the wrong way before it obeys.
 * - The magnitude is clamped. Without a ceiling a flick banks a scroll that
 *   outlives the gesture, and the TUI is still catching up long after the finger
 *   is gone — the overshoot that reads as lag even when the link is fast.
 *
 * Sign convention matches the caller's: positive scrolls up (finger moving down).
 */
export function poolNotches(pending: number, incoming: number, max: number): number {
  const base = pending !== 0 && incoming !== 0 && incoming > 0 !== pending > 0 ? 0 : pending
  return Math.max(-max, Math.min(max, base + incoming))
}

/** Network scroll keeps a bounded pool; local normal-buffer history never uses it. */
export function createAltScrollQueue(send: (notches: number) => void) {
  // Two display frames keeps a swipe responsive without a mutation per notch.
  const flushMs = 32
  const maxNotches = 8
  let pending = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastFlushAt = -Infinity
  let disposed = false
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const flush = () => {
    clearTimer()
    if (disposed || pending === 0) return
    const notches = pending
    pending = 0
    lastFlushAt = Date.now()
    send(notches)
  }
  return {
    start() {
      clearTimer()
      pending = 0
      lastFlushAt = -Infinity
    },
    push(notches: number) {
      if (disposed || notches === 0) return
      pending = poolNotches(pending, notches, maxNotches)
      const wait = flushMs - (Date.now() - lastFlushAt)
      if (wait <= 0) flush()
      else if (timer === null) timer = setTimeout(flush, wait)
    },
    flush,
    dispose() {
      disposed = true
      clearTimer()
      pending = 0
    },
  }
}

/**
 * How many notches a "jump to latest" should send to an alt-buffer TUI.
 *
 * The program never says where its viewport is parked, so the count we sent it
 * on the way up is the distance back down. A little slack past that covers
 * transcript the program grew while the reader was up in its history — overshoot
 * is free, since a TUI clamps at its live end. The slack is only safe when the
 * program tracks the mouse: without it the notches are arrow keys, which a
 * program may read as navigation, so that burst undoes exactly what we sent and
 * not one keypress more. The ceiling keeps a long reading session from turning
 * into a write the size of a novel.
 */
export function jumpNotches(
  back: number,
  opts: { mouseTracking: boolean; slack: number; max: number },
): number {
  if (back <= 0) return 0
  return Math.min(back + (opts.mouseTracking ? opts.slack : 0), opts.max)
}
