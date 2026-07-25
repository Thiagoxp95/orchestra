/**
 * Geometry decisions for the mirrored terminal, kept pure so they can be tested
 * without a DOM (the web tests run in node, like the desktop's).
 *
 * The one rule everything here serves: **the mirror's grid must equal the PTY's
 * grid**. A terminal is a byte stream replayed into a grid of a given size, and
 * a TUI like Claude Code repaints by walking the cursor relative to what it
 * believes that grid is. Replay those same bytes into a grid of a different
 * width and the walk lands on the wrong row: the frame still looks plausible,
 * but the input caret is drawn a row off from the prompt it belongs to (and
 * wider divergences garble outright). So the phone never decides its own size —
 * it *asks* for one (claimGeometry) and renders whatever the bridge grants,
 * scaling the pixels to fit. When the grant matches the request (the phone
 * driving its own size) the scale is exactly 1 and nothing is resampled.
 */

export interface Geometry {
  cols: number
  rows: number
}

export interface Size {
  width: number
  height: number
}

/** Rejects zero/NaN/negative geometry — a mid-layout measurement, basically. */
export function isSaneGeometry(g: Geometry | null | undefined): g is Geometry {
  return (
    !!g &&
    Number.isFinite(g.cols) &&
    Number.isFinite(g.rows) &&
    g.cols > 0 &&
    g.rows > 0
  )
}

export function sameGeometry(a: Geometry | null | undefined, b: Geometry | null | undefined): boolean {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows
}

/**
 * Which geometry to render at, in priority order:
 *
 * 1. `pending` — a claim we just sent. The bridge grants claims verbatim and
 *    re-seeds at the granted size, so adopting it immediately keeps the grid in
 *    step even when the seed arrives before the mirrored geometry echoes back
 *    (two independent Convex subscriptions; either can land first).
 * 2. `mirrored` — the authoritative PTY size from the bridge. This is what
 *    corrects us whenever a claim is refused, clamped, or the desktop takes the
 *    size back.
 *
 * `null` means neither is usable and the caller should fall back to measuring
 * its own viewport — which only happens before the bridge has ever spoken (first
 * paint, mirror offline). It's returned rather than taken as an argument so the
 * caller can skip that measurement, which forces a layout, in the common case.
 */
export function chooseGeometry(
  mirrored: Geometry | null | undefined,
  pending: Geometry | null | undefined,
): Geometry | null {
  if (isSaneGeometry(pending)) return pending
  if (isSaneGeometry(mirrored)) return mirrored
  return null
}

/**
 * A pending claim stops being the truth the moment the bridge echoes it back.
 * Callers must also give up on a claim that is never answered (the desktop took
 * the size back, the mirror is offline) — holding one forever would be the very
 * mismatch this module exists to prevent.
 */
export function claimSettled(
  pending: Geometry | null | undefined,
  mirrored: Geometry | null | undefined,
): boolean {
  if (!pending) return true
  return sameGeometry(pending, mirrored)
}

/**
 * Uniform scale that fits a `natural`-sized terminal into `avail`, picking the
 * smaller of the two ratios so nothing is clipped — the agent's input box lives
 * on the bottom row, and clipping it would be worse than small text.
 *
 * Never magnifies. At 1:1 the grid was measured to fit, so any ratio above 1 is
 * the few leftover pixels of a partial cell; stretching text over them would
 * resample every glyph for no gain.
 */
export function fitScale(natural: Size, avail: Size): number {
  if (natural.width <= 0 || natural.height <= 0 || avail.width <= 0 || avail.height <= 0) return 1
  return Math.min(1, avail.width / natural.width, avail.height / natural.height)
}
