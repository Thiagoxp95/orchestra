import { describe, it, expect } from 'vitest'
import { bridgeLiveness, formatSecondsAgo, OFFLINE_GRACE_MS } from './bridge-liveness'

describe('bridgeLiveness', () => {
  const now = 1_000_000

  it('is live while the socket is connected, however long since the last frame', () => {
    expect(bridgeLiveness({ offlineSince: null, lastSeenAt: now - 600_000 }, now)).toEqual({ stale: false, secondsAgo: null })
  })

  it('stays quiet through a reconnect shorter than the grace', () => {
    expect(bridgeLiveness({ offlineSince: now - (OFFLINE_GRACE_MS - 1), lastSeenAt: now - 7_000 }, now).stale).toBe(false)
  })

  it('reports offline past the grace, with the time since the desktop last spoke', () => {
    expect(bridgeLiveness({ offlineSince: now - 20_000, lastSeenAt: now - 42_500 }, now)).toEqual({ stale: true, secondsAgo: 42 })
  })

  it('has no last-seen age when the desktop never answered', () => {
    expect(bridgeLiveness({ offlineSince: now - 20_000, lastSeenAt: 0 }, now)).toEqual({ stale: true, secondsAgo: null })
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
