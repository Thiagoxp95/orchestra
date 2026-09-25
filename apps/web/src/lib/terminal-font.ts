// Terminal font size, and the three-finger pinch that changes it.
//
// Two fingers are already spoken for on this screen — vertically they roll between
// sessions, horizontally they open the drawer or close the session, and pinched
// inward they pull back to the overview (see lib/session-roll). So the font size
// takes the next free gesture: THREE fingers drawn together shrink the text,
// spread apart grow it, live, in proportion to how far they travel.
//
// Why changing the font size is a real resize and not a CSS zoom: the mirror always
// renders exactly the (cols × rows) the bridge reports and scales the pixels to fit
// (see lib/terminal-geometry). Scaling the whole grid up would just crop it. A
// bigger font means a bigger cell, which means FEWER cols × rows fit this phone —
// so the pinch re-proposes the geometry and the PTY reflows to it. The text really
// does get bigger, and the shell wraps to match.
//
// Kept free of React/DOM imports so it can be unit-tested like the rest of src/lib.

/** The desktop app's terminal size, and the mirror's default (see Terminal.tsx). */
export const TERMINAL_FONT_SIZE_DEFAULT = 14

/**
 * Floor and ceiling. The floor is where xterm's cell stops resolving glyphs on a
 * phone screen; the ceiling is roughly where an 80-column shell no longer fits in
 * any orientation, past which the reflow costs more than the legibility gains.
 */
export const TERMINAL_FONT_SIZE_MIN = 8
export const TERMINAL_FONT_SIZE_MAX = 32

/**
 * Fingers must start this far apart (mean distance from their centroid) for the
 * pinch to arm. Three fingers landing almost on top of each other give a tiny
 * baseline, and every later pixel would then read as a huge ratio — so the gesture
 * would jump to the ceiling on the first move.
 */
export const PINCH_MIN_SPREAD_PX = 24

/**
 * …and they must travel this far before the first size lands. Three fingers never
 * touch down simultaneously or hold perfectly still, so the settling jitter has to
 * be absorbed rather than read as "make the text smaller".
 */
export const PINCH_LOCK_PX = 10

const STORAGE_KEY = 'orchestra:terminalFontSize'

/** Hold a size inside the legible range, at whole pixels. */
export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return TERMINAL_FONT_SIZE_DEFAULT
  return Math.max(TERMINAL_FONT_SIZE_MIN, Math.min(TERMINAL_FONT_SIZE_MAX, Math.round(size)))
}

/**
 * How spread out a set of touch points is: the mean distance from their centroid.
 *
 * Not "the distance between two fingers" — with three there are three pairs, and
 * any one pair can shorten while the hand as a whole opens. The centroid measure
 * reads the whole hand, and is unchanged by rotating or sliding it, so only the
 * squeeze itself moves the number.
 */
export function touchSpread(points: { x: number; y: number }[]): number {
  if (points.length < 2) return 0
  let cx = 0
  let cy = 0
  for (const p of points) {
    cx += p.x
    cy += p.y
  }
  cx /= points.length
  cy /= points.length
  let total = 0
  for (const p of points) total += Math.hypot(p.x - cx, p.y - cy)
  return total / points.length
}

/**
 * The size the pinch is asking for: the size it started from, scaled by how much
 * wider the hand has opened. 1:1 with the gesture — spread the fingers to twice the
 * distance and the text is twice the size — which is the proportion every pinch on
 * the phone already means.
 *
 * Measured against the spread the gesture STARTED at, not the previous frame, so
 * the size is a pure function of where the fingers are now. Rounding per-frame
 * deltas instead would let the errors accumulate, and pinching out and back would
 * not return to the size you began with.
 */
export function pinchFontSize(baseSize: number, baseSpread: number, spread: number): number {
  if (baseSpread < PINCH_MIN_SPREAD_PX) return clampFontSize(baseSize)
  return clampFontSize(baseSize * (spread / baseSpread))
}

/** Whether the hand has opened or closed far enough to mean it. */
export function pinchArmed(baseSpread: number, spread: number): boolean {
  return baseSpread >= PINCH_MIN_SPREAD_PX && Math.abs(spread - baseSpread) >= PINCH_LOCK_PX
}

/**
 * The size the user last pinched to. Persisted rather than re-derived per session:
 * it is a statement about this person's eyes and this phone, so it should outlive
 * the session, the reload and the PWA being evicted from memory.
 *
 * Storage is read defensively — Safari throws on localStorage in some private
 * modes, and a hand-edited value must not be able to render the terminal unusable.
 */
export function readFontSize(storage?: Pick<Storage, 'getItem'>): number {
  const store = storage ?? safeStorage()
  try {
    const raw = store?.getItem(STORAGE_KEY)
    if (raw == null) return TERMINAL_FONT_SIZE_DEFAULT
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampFontSize(parsed) : TERMINAL_FONT_SIZE_DEFAULT
  } catch {
    return TERMINAL_FONT_SIZE_DEFAULT
  }
}

export function writeFontSize(size: number, storage?: Pick<Storage, 'setItem'>): void {
  const store = storage ?? safeStorage()
  try {
    store?.setItem(STORAGE_KEY, String(clampFontSize(size)))
  } catch {
    // Private-mode quota or a disabled store: the size still applies to this
    // session, it just won't survive a reload.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
