import { describe, expect, it } from 'vitest'
import { advanceCursors, slotBytes, type SlotState } from './chunk-cursors'

const LIVE: SlotState = { live: true, bytes: 0 }
const LOADING: SlotState = { live: false, bytes: 0 }
const BUDGET = 48_000

describe('advanceCursors', () => {
  it('leaves both cursors alone when nothing new was consumed', () => {
    const c = { a: 7, b: 5 }
    expect(advanceCursors(c, 7, LIVE, LIVE, BUDGET)).toBe(c)
  })

  it('moves one slot off a cold start, not both', () => {
    expect(advanceCursors({ a: -1, b: -1 }, 3, LIVE, LIVE, BUDGET)).toEqual({ a: 3, b: -1 })
  })

  it('advances the slot that is further behind', () => {
    // b is 5 behind, a only 1 — b is the one whose window costs the most.
    expect(advanceCursors({ a: 9, b: 5 }, 10, LIVE, LIVE, BUDGET)).toEqual({ a: 9, b: 10 })
  })

  it('holds the trailing cursor while its partner is still registering', () => {
    // Moving b here would leave NO registered cursor: a is mid-round-trip, so
    // b's older subscription is the only thing still delivering output.
    const c = { a: 4, b: 1 }
    expect(advanceCursors(c, 6, LOADING, LIVE, BUDGET)).toBe(c)
  })

  it('resumes leapfrogging once the partner comes back', () => {
    expect(advanceCursors({ a: 4, b: 1 }, 6, LIVE, LIVE, BUDGET)).toEqual({ a: 4, b: 6 })
  })

  it('never leaves two cursors on the same seq while one is loading', () => {
    // a already sits at consumed; there is nothing to gain by touching it.
    const c = { a: 6, b: 3 }
    expect(advanceCursors(c, 6, LIVE, LOADING, BUDGET)).toBe(c)
  })

  it('gives up the overlap once the trailing window costs more than it saves', () => {
    // A firehose: b is re-sending 60KB on every update and its partner is stuck.
    // Bandwidth is the bottleneck now, so collapse to single-cursor behaviour.
    const b: SlotState = { live: true, bytes: 60_000 }
    expect(advanceCursors({ a: 4, b: 1 }, 9, LOADING, b, BUDGET)).toEqual({ a: 4, b: 9 })
  })

  it('keeps the overlap while the trailing window is cheap', () => {
    const b: SlotState = { live: true, bytes: 4_000 }
    const c = { a: 4, b: 1 }
    expect(advanceCursors(c, 9, LOADING, b, BUDGET)).toBe(c)
  })

  it('walks a burst forward without ever stranding both cursors', () => {
    // Simulates a round trip that spans three chunks: a slot advanced at seq N
    // stays unregistered until N+3. At every step at least one cursor must be
    // live, or the mirror goes dark mid-stream.
    let cursors = { a: -1, b: -1 }
    const registeredAt = { a: -Infinity, b: -Infinity }
    for (let seq = 0; seq < 20; seq++) {
      const liveA = seq - registeredAt.a >= 3
      const liveB = seq - registeredAt.b >= 3
      expect(liveA || liveB).toBe(true)
      const next = advanceCursors(
        cursors,
        seq,
        { live: liveA, bytes: 0 },
        { live: liveB, bytes: 0 },
        BUDGET,
      )
      if (next.a !== cursors.a) registeredAt.a = seq
      if (next.b !== cursors.b) registeredAt.b = seq
      cursors = next
    }
    // And it does keep up rather than pinning one cursor at the cold start.
    expect(Math.max(cursors.a, cursors.b)).toBeGreaterThan(10)
  })
})

describe('slotBytes', () => {
  it('sums the payload a held-back cursor is re-sending', () => {
    expect(slotBytes([{ data: 'abc' }, { data: 'de' }])).toBe(5)
  })

  it('treats a loading slot as costing nothing', () => {
    expect(slotBytes(undefined)).toBe(0)
  })
})
