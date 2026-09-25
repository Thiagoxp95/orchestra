import { describe, expect, it } from 'vitest'
import {
  clampFontSize,
  pinchArmed,
  pinchFontSize,
  readFontSize,
  touchSpread,
  writeFontSize,
  PINCH_LOCK_PX,
  PINCH_MIN_SPREAD_PX,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from './terminal-font'

describe('clampFontSize', () => {
  it('holds the size inside the legible range, at whole pixels', () => {
    expect(clampFontSize(14.4)).toBe(14)
    expect(clampFontSize(14.6)).toBe(15)
    expect(clampFontSize(1)).toBe(TERMINAL_FONT_SIZE_MIN)
    expect(clampFontSize(400)).toBe(TERMINAL_FONT_SIZE_MAX)
  })

  it('falls back to the default rather than propagating a NaN into xterm', () => {
    expect(clampFontSize(NaN)).toBe(TERMINAL_FONT_SIZE_DEFAULT)
    expect(clampFontSize(Infinity)).toBe(TERMINAL_FONT_SIZE_DEFAULT)
  })
})

describe('touchSpread', () => {
  it('is the mean distance from the centroid', () => {
    // Three fingers 10px out from a shared centre, 120° apart.
    const r3 = 8.660254037844387
    expect(
      touchSpread([{ x: 10, y: 0 }, { x: -5, y: r3 }, { x: -5, y: -r3 }]),
    ).toBeCloseTo(10, 5)
    // …and an uneven hand is the mean, not the widest pair.
    expect(touchSpread([{ x: 0, y: -10 }, { x: 0, y: -10 }, { x: 0, y: 20 }])).toBeCloseTo(40 / 3, 5)
  })

  it('ignores sliding the whole hand', () => {
    const hand = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 15, y: 26 }]
    const moved = hand.map((p) => ({ x: p.x + 120, y: p.y - 45 }))
    expect(touchSpread(moved)).toBeCloseTo(touchSpread(hand), 5)
  })

  it('grows as the hand opens', () => {
    const closed = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 17 }]
    const open = closed.map((p) => ({ x: p.x * 3, y: p.y * 3 }))
    expect(touchSpread(open)).toBeCloseTo(touchSpread(closed) * 3, 5)
  })

  it('reports nothing for fewer than two points — there is no spread to read', () => {
    expect(touchSpread([])).toBe(0)
    expect(touchSpread([{ x: 5, y: 5 }])).toBe(0)
  })
})

describe('pinchFontSize', () => {
  it('scales the starting size 1:1 with the hand', () => {
    expect(pinchFontSize(14, 100, 200)).toBe(28)
    // 14 × 0.5 = 7, below the floor.
    expect(pinchFontSize(14, 100, 50)).toBe(TERMINAL_FONT_SIZE_MIN)
    expect(pinchFontSize(20, 100, 50)).toBe(10)
  })

  it('returns to the starting size when the fingers come back', () => {
    // Measured against the gesture's own baseline, so the round trip is exact —
    // a per-frame delta would have accumulated rounding by now.
    expect(pinchFontSize(14, 100, 100)).toBe(14)
    expect(pinchFontSize(14, 100, 137)).toBe(19)
    expect(pinchFontSize(14, 100, 100)).toBe(14)
  })

  it('clamps rather than running off either end', () => {
    expect(pinchFontSize(14, 100, 1000)).toBe(TERMINAL_FONT_SIZE_MAX)
    expect(pinchFontSize(14, 100, 1)).toBe(TERMINAL_FONT_SIZE_MIN)
  })

  it('refuses a baseline too small to measure against', () => {
    // Three fingers landing on top of each other: every later pixel would read as
    // a huge ratio and the gesture would slam into the ceiling on its first move.
    expect(pinchFontSize(14, PINCH_MIN_SPREAD_PX - 1, 400)).toBe(14)
  })
})

describe('pinchArmed', () => {
  it('absorbs the jitter of three fingers settling', () => {
    expect(pinchArmed(100, 100 + PINCH_LOCK_PX - 1)).toBe(false)
    expect(pinchArmed(100, 100 - (PINCH_LOCK_PX - 1))).toBe(false)
  })

  it('arms once the hand has deliberately opened or closed', () => {
    expect(pinchArmed(100, 100 + PINCH_LOCK_PX)).toBe(true)
    expect(pinchArmed(100, 100 - PINCH_LOCK_PX)).toBe(true)
  })

  it('never arms on a baseline too small to measure against', () => {
    expect(pinchArmed(PINCH_MIN_SPREAD_PX - 1, 400)).toBe(false)
  })
})

describe('font size persistence', () => {
  const fakeStore = (initial?: string) => {
    let value = initial
    return {
      getItem: () => value ?? null,
      setItem: (_k: string, v: string) => {
        value = v
      },
      read: () => value,
    }
  }

  it('round-trips the size the user pinched to', () => {
    const store = fakeStore()
    writeFontSize(22, store)
    expect(readFontSize(store)).toBe(22)
  })

  it('stores a clamped size, so a stale ceiling can never be re-read as valid', () => {
    const store = fakeStore()
    writeFontSize(999, store)
    expect(store.read()).toBe(String(TERMINAL_FONT_SIZE_MAX))
  })

  it('defaults when nothing is stored', () => {
    expect(readFontSize(fakeStore())).toBe(TERMINAL_FONT_SIZE_DEFAULT)
  })

  it('defaults on a garbage value rather than rendering an unreadable terminal', () => {
    expect(readFontSize(fakeStore('not a number'))).toBe(TERMINAL_FONT_SIZE_DEFAULT)
    expect(readFontSize(fakeStore('0'))).toBe(TERMINAL_FONT_SIZE_MIN)
  })

  it('survives a storage that throws (Safari private mode)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(readFontSize(throwing)).toBe(TERMINAL_FONT_SIZE_DEFAULT)
    expect(() => writeFontSize(20, throwing)).not.toThrow()
  })
})
