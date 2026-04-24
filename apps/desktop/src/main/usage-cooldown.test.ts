import { describe, it, expect } from 'vitest'
import { computeClaudeCooldown, nextProbeDelayMs } from './usage-cooldown'

describe('computeClaudeCooldown', () => {
  const NOW = 1_700_000_000_000
  const MIN = 60_000
  const BASE = 30 * MIN
  const MAX = 60 * MIN

  it('returns base backoff on first failure when no server floor', () => {
    expect(computeClaudeCooldown(1, 0, NOW)).toBe(NOW + BASE)
  })

  it('doubles the backoff on the second consecutive failure, capped at the max', () => {
    expect(computeClaudeCooldown(2, 0, NOW)).toBe(NOW + MAX)
  })

  it('stays pinned at the max for deeper escalations', () => {
    expect(computeClaudeCooldown(5, 0, NOW)).toBe(NOW + MAX)
  })

  it('honors a server-provided Retry-After floor when higher than the escalated backoff', () => {
    const serverFloor = NOW + 90 * MIN
    expect(computeClaudeCooldown(1, serverFloor, NOW)).toBe(serverFloor)
  })

  it('prefers the escalated backoff when the server floor is lower', () => {
    const serverFloor = NOW + 5 * MIN
    expect(computeClaudeCooldown(2, serverFloor, NOW)).toBe(NOW + MAX)
  })

  it('treats a zero failure count as a single failure (safety fallback)', () => {
    expect(computeClaudeCooldown(0, 0, NOW)).toBe(NOW + BASE)
  })
})

describe('nextProbeDelayMs', () => {
  const BASE = 15 * 60_000

  it('returns a delay within ±20% of the base interval', () => {
    for (let i = 0; i < 200; i++) {
      const delay = nextProbeDelayMs(BASE)
      expect(delay).toBeGreaterThanOrEqual(BASE * 0.8)
      expect(delay).toBeLessThanOrEqual(BASE * 1.2)
    }
  })

  it('produces different values across calls (jitter is applied)', () => {
    const samples = new Set<number>()
    for (let i = 0; i < 20; i++) samples.add(nextProbeDelayMs(BASE))
    expect(samples.size).toBeGreaterThan(1)
  })
})
