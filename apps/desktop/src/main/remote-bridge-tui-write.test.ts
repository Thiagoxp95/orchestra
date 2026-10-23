import { describe, it, expect, vi } from 'vitest'
import {
  QUIET_MS,
  SETTLE_CAP_MS,
  READY_CAP_MS,
  sendPrompt,
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

describe('sendPrompt', () => {
  it('waits for the TUI, pastes the whole prompt once, and presses Enter until the turn starts', async () => {
    const { deps, log, now } = makeDeps({ ingestMs: 100 })
    let pastedAt = -1
    const submits: number[] = []
    const result = await sendPrompt(
      {
        ...deps,
        // The agent boots for 2s before it turns bracketed paste on.
        isReady: async () => now() >= 2_000,
        // The first Enter is lost (claude held the draft); the second one takes.
        isSubmitted: () => submits.length >= 2,
        readScreen: async () => (submits.length < 2 ? '❯ [Pasted text #1 +1 lines]' : '❯ '),
        write: (data) => {
          if (data.startsWith('\x1b[200~')) pastedAt = now()
          if (data === '\r') submits.push(now())
          deps.write(data)
        },
      },
      'Fix the\u200b send path\r\nplease\ufeff\x1b[201~ now',
    )

    expect(result).toEqual({ ready: true, submitted: true, enters: 2 })
    // One atomic bracketed paste: CRLF → LF, invisible characters and ESC gone.
    expect(log[0].data).toBe('\x1b[200~Fix the send path\nplease[201~ now\x1b[201~')
    expect(pastedAt).toBeGreaterThanOrEqual(2_000)
    expect(pastedAt).toBeLessThan(READY_CAP_MS)
    // Enter is its own write, only after the TUI answered the paste.
    expect(log.slice(1).map((l) => l.data)).toEqual(['\r', '\r'])
    expect(submits[0]).toBeGreaterThanOrEqual(pastedAt + 100 + QUIET_MS)
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
