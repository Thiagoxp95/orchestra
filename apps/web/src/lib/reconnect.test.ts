import { describe, it, expect } from 'vitest'
import { attemptReconnect, describeReconnectOutcome, type ReconnectDeps } from './reconnect'

/**
 * A fake clock: `sleep` resolves immediately but advances a counter, so a test
 * can script "the socket comes up at 1s, a push lands at 2s" without waiting.
 */
function harness(script: {
  connectedAfterMs?: number
  pushAtMs?: number
  startUpdatedAt?: number | null
}) {
  let elapsed = 0
  const pokes: number[] = []
  const start = script.startUpdatedAt === undefined ? 500_000 : script.startUpdatedAt
  const deps: ReconnectDeps = {
    poke: () => pokes.push(elapsed),
    isConnected: () => script.connectedAfterMs != null && elapsed >= script.connectedAfterMs,
    updatedAt: () => (script.pushAtMs != null && elapsed >= script.pushAtMs ? 900_000 : start),
    sleep: async (ms) => {
      elapsed += ms
    },
  }
  return { deps, pokes, elapsed: () => elapsed }
}

describe('attemptReconnect', () => {
  it('reports live as soon as a newer push lands', async () => {
    const h = harness({ connectedAfterMs: 0, pushAtMs: 1_000 })
    expect(await attemptReconnect(h.deps)).toBe('live')
    // Returned on the first poll past the push rather than running the timeout out.
    expect(h.elapsed()).toBeLessThan(2_000)
  })

  it('pokes the client immediately, before waiting on anything', async () => {
    const h = harness({ connectedAfterMs: 0, pushAtMs: 250 })
    await attemptReconnect(h.deps)
    expect(h.pokes[0]).toBe(0)
  })

  it('blames this device when the socket never comes up', async () => {
    const h = harness({})
    expect(await attemptReconnect(h.deps, { timeoutMs: 2_000 })).toBe('no-socket')
  })

  it('blames the desktop when the socket is up but nothing new arrives', async () => {
    const h = harness({ connectedAfterMs: 0 })
    expect(await attemptReconnect(h.deps, { timeoutMs: 2_000 })).toBe('desktop-silent')
  })

  it('keeps poking while the socket stays down, but no faster than pokeEveryMs', async () => {
    const h = harness({})
    await attemptReconnect(h.deps, { timeoutMs: 3_000, pollMs: 250, pokeEveryMs: 1_000 })
    // t=0 (immediate), then roughly one per second across the 3s window.
    expect(h.pokes.length).toBeLessThanOrEqual(4)
    expect(h.pokes.length).toBeGreaterThanOrEqual(3)
  })

  it('stops poking once the socket is up', async () => {
    const h = harness({ connectedAfterMs: 500 })
    await attemptReconnect(h.deps, { timeoutMs: 3_000, pollMs: 250, pokeEveryMs: 1_000 })
    expect(h.pokes).toEqual([0])
  })

  it('does not mistake the pre-existing stamp for a fresh push', async () => {
    // updatedAt never moves; a naive "is there a value?" check would say live.
    const h = harness({ connectedAfterMs: 0, startUpdatedAt: 500_000 })
    expect(await attemptReconnect(h.deps, { timeoutMs: 1_000 })).toBe('desktop-silent')
  })

  it('treats any push at all as news when nothing was ever mirrored', async () => {
    const h = harness({ connectedAfterMs: 0, pushAtMs: 500, startUpdatedAt: null })
    expect(await attemptReconnect(h.deps, { timeoutMs: 2_000 })).toBe('live')
  })

  it('reports a silent desktop when the socket was already up all along', async () => {
    // sawSocket is seeded from the live socket, not assumed false at t=0.
    const h = harness({ connectedAfterMs: 0 })
    expect(await attemptReconnect(h.deps, { timeoutMs: 250, pollMs: 250 })).toBe('desktop-silent')
  })
})

describe('describeReconnectOutcome', () => {
  it('says something specific for every outcome', () => {
    expect(describeReconnectOutcome('live')).toMatch(/reconnected/i)
    expect(describeReconnectOutcome('no-socket')).toMatch(/device/i)
    expect(describeReconnectOutcome('desktop-silent')).toMatch(/computer/i)
  })
})
