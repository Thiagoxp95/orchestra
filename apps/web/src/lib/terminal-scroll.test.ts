import { describe, expect, it } from 'vitest'
import { altScrollSequence, poolNotches } from './terminal-scroll'

describe('altScrollSequence', () => {
  it('sends SGR wheel-up when the program tracks the mouse', () => {
    expect(altScrollSequence({ mouseTracking: true, applicationCursor: false }, true)).toBe('\x1b[<64;1;1M')
  })

  it('sends SGR wheel-down when the program tracks the mouse', () => {
    expect(altScrollSequence({ mouseTracking: true, applicationCursor: false }, false)).toBe('\x1b[<65;1;1M')
  })

  it('falls back to arrow keys when the mouse is not tracked', () => {
    expect(altScrollSequence({ mouseTracking: false, applicationCursor: false }, true)).toBe('\x1b[A')
    expect(altScrollSequence({ mouseTracking: false, applicationCursor: false }, false)).toBe('\x1b[B')
  })

  it('uses application-cursor arrow encoding when DECCKM is on', () => {
    expect(altScrollSequence({ mouseTracking: false, applicationCursor: true }, true)).toBe('\x1bOA')
    expect(altScrollSequence({ mouseTracking: false, applicationCursor: true }, false)).toBe('\x1bOB')
  })

  it('prefers mouse-wheel over arrows even with application cursor keys on', () => {
    expect(altScrollSequence({ mouseTracking: true, applicationCursor: true }, true)).toBe('\x1b[<64;1;1M')
  })
})

describe('poolNotches', () => {
  const MAX = 8

  it('accumulates notches earned in the same direction', () => {
    expect(poolNotches(0, 2, MAX)).toBe(2)
    expect(poolNotches(2, 3, MAX)).toBe(5)
    expect(poolNotches(-2, -3, MAX)).toBe(-5)
  })

  it('drops the pool when the swipe reverses', () => {
    // 5 notches of scroll-up are queued and the finger changes its mind: the
    // pool must not net out to +4, it must start over at the new direction.
    expect(poolNotches(5, -1, MAX)).toBe(-1)
    expect(poolNotches(-5, 1, MAX)).toBe(1)
  })

  it('clamps a flick so it cannot bank scroll that outlives the gesture', () => {
    expect(poolNotches(6, 9, MAX)).toBe(MAX)
    expect(poolNotches(-6, -9, MAX)).toBe(-MAX)
  })

  it('is a no-op for an empty burst', () => {
    expect(poolNotches(4, 0, MAX)).toBe(4)
    expect(poolNotches(0, 0, MAX)).toBe(0)
  })
})
