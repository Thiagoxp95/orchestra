import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createThrottle } from './throttle'

describe('createThrottle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires immediately on the leading edge', () => {
    const fn = vi.fn()
    const t = createThrottle(fn, 200)
    t('a')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenLastCalledWith('a')
  })

  it('coalesces a burst into the leading call plus one trailing call with the latest args', () => {
    const fn = vi.fn<(n: number) => void>()
    const t = createThrottle(fn, 200)
    t(1) // leading → fires now
    t(2) // within window → pending
    t(3) // within window → pending (latest)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(200)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith(3) // trailing delivers the latest, not 2
  })

  it('cannot be starved: a continuous stream still fires roughly every interval', () => {
    const fn = vi.fn<(n: number) => void>()
    const t = createThrottle(fn, 100)
    // Call every 10ms for ~1s. A debounce reset on each call would NEVER fire;
    // the throttle keeps firing ~once per 100ms window.
    for (let i = 0; i < 100; i++) {
      t(i)
      vi.advanceTimersByTime(10)
    }
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(fn.mock.calls.length).toBeLessThan(50)
  })

  it('fires again on the leading edge after an idle gap', () => {
    const fn = vi.fn()
    const t = createThrottle(fn, 200)
    t('x')
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(500) // idle well past the window
    t('y')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith('y')
  })
})
