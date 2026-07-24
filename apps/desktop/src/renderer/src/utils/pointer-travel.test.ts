import { describe, expect, it } from 'vitest'
import { PointerTravel, RECLAIM_TRAVEL_PX } from './pointer-travel'

describe('PointerTravel', () => {
  it('only anchors on the first position', () => {
    const t = new PointerTravel()
    expect(t.moved(500, 500)).toBe(false)
  })

  it('ignores jitter that never adds up', () => {
    const t = new PointerTravel()
    t.moved(500, 500)
    // A cursor twitching between two adjacent pixels: distance accumulates, but
    // it takes far more than a handful of frames to reach the threshold.
    for (let i = 0; i < 10; i++) {
      expect(t.moved(500 + (i % 2), 500)).toBe(false)
    }
  })

  it('trips once travel crosses the threshold', () => {
    const t = new PointerTravel()
    t.moved(0, 0)
    expect(t.moved(RECLAIM_TRAVEL_PX - 1, 0)).toBe(false)
    expect(t.moved(RECLAIM_TRAVEL_PX + 1, 0)).toBe(true)
  })

  it('accumulates slow movement across many small steps', () => {
    const t = new PointerTravel()
    t.moved(0, 0)
    let tripped = false
    for (let i = 1; i <= RECLAIM_TRAVEL_PX + 2 && !tripped; i++) tripped = t.moved(i, 0)
    expect(tripped).toBe(true)
  })

  it('trips once per burst, not once per frame after the threshold', () => {
    const t = new PointerTravel()
    t.moved(0, 0)
    expect(t.moved(0, RECLAIM_TRAVEL_PX * 4)).toBe(true)
    // Next frame re-anchors, so a second big jump is needed for a second trip.
    expect(t.moved(0, RECLAIM_TRAVEL_PX * 8)).toBe(false)
    expect(t.moved(0, RECLAIM_TRAVEL_PX * 12)).toBe(true)
  })

  it('drops accumulated travel on reset', () => {
    const t = new PointerTravel()
    t.moved(0, 0)
    t.moved(RECLAIM_TRAVEL_PX - 2, 0)
    t.reset()
    // Without the reset this next step would have tripped it.
    expect(t.moved(RECLAIM_TRAVEL_PX - 2, 0)).toBe(false)
    expect(t.moved(RECLAIM_TRAVEL_PX * 2, 0)).toBe(true)
  })

  it('ignores non-finite coordinates', () => {
    const t = new PointerTravel()
    t.moved(0, 0)
    expect(t.moved(Number.NaN, 0)).toBe(false)
    // The NaN was dropped rather than poisoning the accumulator.
    expect(t.moved(RECLAIM_TRAVEL_PX * 2, 0)).toBe(true)
  })

  it('measures diagonal distance, not per-axis', () => {
    const t = new PointerTravel()
    t.moved(0, 0)
    // 3-4-5: each axis alone is under the threshold, the hypotenuse is over.
    expect(t.moved(RECLAIM_TRAVEL_PX * 0.6, RECLAIM_TRAVEL_PX * 0.8)).toBe(true)
  })
})
