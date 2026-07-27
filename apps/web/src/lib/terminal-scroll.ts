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
