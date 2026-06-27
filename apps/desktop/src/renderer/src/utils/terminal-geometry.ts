// Pure geometry + resize-planning helpers shared by the terminal fit controller.
//
// These are deliberately DOM-free so they can be unit-tested in the node test
// env (the desktop app has no jsdom). The controller in
// `hooks/terminal-autofit.ts` reads the real container/cell metrics from the
// DOM and xterm, then defers every decision to these functions.

export interface Geometry {
  cols: number
  rows: number
}

export interface ResizeStep {
  cols: number
  rows: number
  /** ms to wait AFTER applying this step before the next one (0 for the final step). */
  settleMs: number
}

// xterm's own floor (FitAddon clamps to Math.max(2, …) cols, Math.max(1, …) rows).
const MIN_COLS = 2
const MIN_ROWS = 1
// A mis-measured (fallback-font / 0x0-open-corrupted) cell can yield wildly
// inflated cell widths and thus absurd col/row counts; reject those so a
// corrupt fit is never propagated to the PTY.
const MAX_DIM = 2000

const DEFAULT_NUDGE_SETTLE_MS = 60

/** A geometry is sane when both dimensions are integers within xterm's usable range. */
export function isSaneGeometry(g: Geometry): boolean {
  return (
    Number.isInteger(g.cols) &&
    Number.isInteger(g.rows) &&
    g.cols >= MIN_COLS &&
    g.rows >= MIN_ROWS &&
    g.cols <= MAX_DIM &&
    g.rows <= MAX_DIM
  )
}

/** True when `next` differs from `prev` (a missing `prev` counts as the first sync). */
export function geometryChanged(prev: Geometry | null | undefined, next: Geometry): boolean {
  if (!prev) return true
  return prev.cols !== next.cols || prev.rows !== next.rows
}

/**
 * A guaranteed-different row count, so a resize back to the same size still
 * delivers a SIGWINCH and forces the TUI to repaint. Mirrors the row±1 trick in
 * `remote-bridge-resize-nudge.ts`.
 */
export function nudgeRows(rows: number): number {
  return rows > MIN_ROWS ? rows - 1 : rows + 1
}

/**
 * Decide what to send to the PTY when the terminal has settled at `next`.
 *
 *  - garbage `next`                         -> []                  (never propagate a corrupt fit)
 *  - first sync / real size change          -> [next]             (the size delta itself delivers SIGWINCH)
 *  - same size + forceRepaint (font heal)   -> [nudge, next]      (force a clean repaint to clear ghost lines)
 *  - same size, no force                    -> []                  (a same-size resize is an inert no-op)
 */
export function planPtyResize(opts: {
  last: Geometry | null | undefined
  next: Geometry
  forceRepaint?: boolean
  nudgeSettleMs?: number
}): ResizeStep[] {
  const { last, next, forceRepaint = false, nudgeSettleMs = DEFAULT_NUDGE_SETTLE_MS } = opts

  if (!isSaneGeometry(next)) return []

  const target: ResizeStep = { cols: next.cols, rows: next.rows, settleMs: 0 }

  if (geometryChanged(last, next)) {
    // A genuine size change already triggers SIGWINCH → full TUI repaint, which
    // clears any stale/duplicate cells. No nudge needed even when healing.
    return [target]
  }

  if (forceRepaint && last) {
    // Size happens to be unchanged but we still need the TUI to repaint (e.g. the
    // font swapped without changing the column count). Force it with a nudge.
    return [{ cols: next.cols, rows: nudgeRows(next.rows), settleMs: nudgeSettleMs }, target]
  }

  return []
}
