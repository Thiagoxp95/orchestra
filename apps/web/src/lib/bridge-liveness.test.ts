import { describe, it, expect } from 'vitest'
import { bridgeLiveness, formatSecondsAgo, BRIDGE_STALE_MS } from './bridge-liveness'

describe('bridgeLiveness', () => {
  it('is not stale right after a push', () => {
    const now = 1_000_000
    expect(bridgeLiveness(now, now)).toEqual({ stale: false, secondsAgo: 0 })
  })

  it('is not stale within the threshold', () => {
    const now = 1_000_000
    const result = bridgeLiveness(now - (BRIDGE_STALE_MS - 1), now)
    expect(result.stale).toBe(false)
  })

  it('is stale once the threshold is exceeded', () => {
    const now = 1_000_000
    const result = bridgeLiveness(now - (BRIDGE_STALE_MS + 1), now)
    expect(result.stale).toBe(true)
  })

  it('reports whole seconds since the last push', () => {
    const now = 1_000_000
    expect(bridgeLiveness(now - 42_500, now).secondsAgo).toBe(42)
  })

  it('never reports negative elapsed when clocks skew', () => {
    const now = 1_000_000
    // Desktop clock slightly ahead of the phone's — updatedAt in the future.
    expect(bridgeLiveness(now + 5_000, now)).toEqual({ stale: false, secondsAgo: 0 })
  })

  it('returns no signal when the desktop never pushed', () => {
    expect(bridgeLiveness(undefined, 1_000_000)).toEqual({ stale: false, secondsAgo: null })
    expect(bridgeLiveness(null, 1_000_000)).toEqual({ stale: false, secondsAgo: null })
  })

  it('honors a custom threshold', () => {
    const now = 1_000_000
    expect(bridgeLiveness(now - 5_000, now, 1_000).stale).toBe(true)
    expect(bridgeLiveness(now - 5_000, now, 10_000).stale).toBe(false)
  })
})

describe('formatSecondsAgo', () => {
  it('formats seconds under a minute', () => {
    expect(formatSecondsAgo(0)).toBe('0s')
    expect(formatSecondsAgo(59)).toBe('59s')
  })

  it('formats minutes under an hour', () => {
    expect(formatSecondsAgo(60)).toBe('1m')
    expect(formatSecondsAgo(3599)).toBe('59m')
  })

  it('formats hours past an hour', () => {
    expect(formatSecondsAgo(3600)).toBe('1h')
    expect(formatSecondsAgo(7200)).toBe('2h')
  })
})
