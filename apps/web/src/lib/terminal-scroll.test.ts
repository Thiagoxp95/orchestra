import { describe, expect, it, vi } from 'vitest'
import { altScrollSequence, createAltScrollQueue, jumpNotches, poolNotches } from './terminal-scroll'

describe('alternate-screen scroll latency', () => {
  it('sends the first notch immediately, coalesces within 32ms, and flushes on release', () => {
    vi.useFakeTimers()
    try {
      const sent: { count: number; at: number }[] = []
      const started = Date.now()
      const queue = createAltScrollQueue(count => sent.push({ count, at: Date.now() - started }))
      queue.start()
      queue.push(1)
      vi.advanceTimersByTime(10)
      queue.push(2)
      queue.push(3)
      vi.advanceTimersByTime(22)
      expect(sent).toEqual([{ count: 1, at: 0 }, { count: 5, at: 32 }])
      vi.advanceTimersByTime(5)
      queue.push(2)
      queue.flush()
      expect(sent.at(-1)).toEqual({ count: 2, at: 37 })
      queue.dispose()
    } finally { vi.useRealTimers() }
  })

  it('bounds a fast flick, replaces reversed intent, and drops canceled work', () => {
    vi.useFakeTimers()
    try {
      const sent: number[] = []
      const queue = createAltScrollQueue(count => sent.push(count))
      queue.push(40)
      queue.push(5)
      queue.push(-40)
      vi.advanceTimersByTime(32)
      expect(sent).toEqual([8, -8])
      queue.push(-3)
      queue.dispose()
      vi.advanceTimersByTime(100)
      queue.push(1)
      expect(sent).toEqual([8, -8])
    } finally { vi.useRealTimers() }
  })

  it('starts a new gesture immediately even if the previous gesture just flushed', () => {
    vi.useFakeTimers()
    try {
      const sent: number[] = []
      const queue = createAltScrollQueue(count => sent.push(count))
      queue.push(1)
      queue.flush()
      vi.advanceTimersByTime(5)
      queue.start()
      queue.push(-1)
      expect(sent).toEqual([1, -1])
      queue.dispose()
    } finally { vi.useRealTimers() }
  })
})

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

describe('jumpNotches', () => {
  const opts = { mouseTracking: true, slack: 12, max: 240 }

  it('sends nothing when the program is already at its live end', () => {
    expect(jumpNotches(0, opts)).toBe(0)
    expect(jumpNotches(-3, opts)).toBe(0)
  })

  it('undoes the notches sent, plus slack for scroll the program did itself', () => {
    expect(jumpNotches(5, opts)).toBe(17)
  })

  it('adds no slack without mouse tracking — those notches are arrow keys', () => {
    expect(jumpNotches(5, { ...opts, mouseTracking: false })).toBe(5)
  })

  it('caps a long reading session at the ceiling', () => {
    expect(jumpNotches(1000, opts)).toBe(240)
  })
})
