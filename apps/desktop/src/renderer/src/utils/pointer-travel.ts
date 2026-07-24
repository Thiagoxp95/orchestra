// "Is someone actually at the computer?" from raw pointer positions, as a pure
// accumulator so the threshold is unit-testable. App.tsx feeds it mousemove and
// reclaims geometry ownership from the phone when it trips.
//
// Distance, not event count: a single mousemove means nothing (the OS emits them
// for a cursor that drifts a pixel under a moving window, or for a bumped desk),
// while a hand deliberately moving the mouse covers real screen distance in a
// few frames. Accumulating means a slow, gentle nudge trips it just as surely as
// a fast flick — it only takes longer.

/**
 * Screen pixels of accumulated cursor travel that count as "the user is back".
 * Roughly a deliberate wiggle: far enough that hardware jitter or a one-frame
 * hop can't reach it, short enough that you never think about it.
 */
export const RECLAIM_TRAVEL_PX = 24

export class PointerTravel {
  private last: { x: number; y: number } | null = null
  private travel = 0

  /** Forget accumulated travel and the anchor point. */
  reset(): void {
    this.last = null
    this.travel = 0
  }

  /**
   * Feed a cursor position. Returns true on the move that pushes total travel
   * past `thresholdPx`, and resets — so a caller gets one trip per burst, not
   * one per frame after the threshold. The first position after a reset only
   * anchors (no distance to measure yet).
   */
  moved(x: number, y: number, thresholdPx: number = RECLAIM_TRAVEL_PX): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    const prev = this.last
    this.last = { x, y }
    if (!prev) return false
    this.travel += Math.hypot(x - prev.x, y - prev.y)
    if (this.travel < thresholdPx) return false
    this.reset()
    return true
  }
}
