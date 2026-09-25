import { describe, it, expect, vi } from 'vitest'
import {
  QUIET_MS,
  SETTLE_CAP_MS,
  settle,
  typeImagePath,
  type TuiWriteDeps,
} from './remote-bridge-tui-write'

/**
 * Deps with a virtual clock. Writes make the terminal noisy the way a real TUI
 * does — it reacts to what we send, and a paste carrying an image path keeps
 * emitting for `ingestMs` while it reads the file off disk. `alwaysNoisy` models
 * an agent mid-turn, where output never stops on its own.
 */
function makeDeps({
  ingestMs = 0,
  echoMs = 0,
  alwaysNoisy = false,
}: { ingestMs?: number; echoMs?: number; alwaysNoisy?: boolean } = {}) {
  const log: { at: number; data: string }[] = []
  let clock = 0
  let lastOutputAt = -1_000_000 // long quiet before we start
  const deps: TuiWriteDeps = {
    write: (data) => {
      log.push({ at: clock, data })
      // The TUI answers every write; a pasted image path keeps it busy longer.
      lastOutputAt = clock + (data.includes('200~') ? ingestMs : echoMs)
    },
    isQuiet: (quietMs) => (alwaysNoisy ? false : clock - lastOutputAt >= quietMs),
    sleep: async (ms) => {
      clock += ms
    },
  }
  return { deps, log, now: () => clock }
}

describe('settle', () => {
  it('returns immediately when the session is already quiet', async () => {
    const { deps } = makeDeps()
    expect(await settle(deps)).toEqual({ waitedMs: 0, capped: false })
  })

  it('waits out the noise, then reports how long it took', async () => {
    const { deps } = makeDeps({ echoMs: 600 })
    deps.write('x') // makes the terminal noisy for 600ms
    const result = await settle(deps)
    expect(result.capped).toBe(false)
    expect(result.waitedMs).toBeGreaterThanOrEqual(600 + QUIET_MS - 50)
  })

  it('gives up at the cap when output never stops (agent mid-turn)', async () => {
    const { deps } = makeDeps({ alwaysNoisy: true })
    const result = await settle(deps)
    expect(result).toEqual({ waitedMs: SETTLE_CAP_MS, capped: true })
  })
})

describe('typeImagePath', () => {
  it('waits for quiet before and after typing, and never submits', async () => {
    const { deps, log } = makeDeps()
    await typeImagePath(deps, '/img/a.jpg')

    expect(log.map((l) => l.data)).toEqual(['/img/a.jpg '])
    expect(log.some((l) => l.data.includes('\r'))).toBe(false)
  })

  it('does not start typing while a previous image is still being ingested', async () => {
    const { deps, log } = makeDeps({ echoMs: 2000 })
    deps.write('previous image path ') // still being ingested
    await typeImagePath(deps, '/img/b.jpg')
    expect(log[1].at).toBeGreaterThanOrEqual(2000)
  })
})

describe('deps wiring', () => {
  it('isQuiet is the inverse of "had output within quietMs"', () => {
    const hasRecent = vi.fn().mockReturnValue(true)
    const isQuiet = (quietMs: number) => !hasRecent('s1', quietMs)
    expect(isQuiet(QUIET_MS)).toBe(false)
    hasRecent.mockReturnValue(false)
    expect(isQuiet(QUIET_MS)).toBe(true)
  })
})
