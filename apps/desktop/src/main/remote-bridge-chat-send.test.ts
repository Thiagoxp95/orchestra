import { describe, it, expect, vi } from 'vitest'
import {
  MIN_CR_DELAY_MS,
  QUIET_MS,
  SETTLE_CAP_MS,
  settle,
  submitChatMessage,
  typeImagePath,
  type ChatSendDeps,
  CLEAR_INPUT,
  CLEAR_BYTE,
  CLEAR_BURST_LEN,
  CLEAR_BYTE_GAP_MS,
} from './remote-bridge-chat-send'

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
  const deps: ChatSendDeps = {
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

describe('submitChatMessage', () => {
  it('clears, pastes, and submits in order', async () => {
    const { deps, log } = makeDeps()
    await submitChatMessage(deps, '/img/a.jpg hello')

    const afterClear = log.filter((l) => l.data !== CLEAR_BYTE).map((l) => l.data)
    expect(afterClear).toEqual(['\x1b[200~/img/a.jpg hello\x1b[201~', '\r'])
  })

  // The bug this guards: written as one 79-byte chunk the burst arrives in a
  // single stdin read and claude 2.1.233 treats it as PASTED TEXT — the NAKs go
  // into the composer instead of clearing it, and the agent receives a message
  // prefixed with 79 control characters.
  it('drips the clear one Ctrl-U per write, before the paste', async () => {
    const { deps, log } = makeDeps()
    await submitChatMessage(deps, 'hi')

    const clear = log.slice(0, CLEAR_BURST_LEN)
    expect(clear).toHaveLength(CLEAR_INPUT.length)
    expect(clear.every((l) => l.data === CLEAR_BYTE)).toBe(true)
    expect(new Set(clear.map((l) => l.at)).size).toBe(CLEAR_BURST_LEN) // spaced, not batched
    expect(log[CLEAR_BURST_LEN].data).toContain('200~')
  })

  it('never batches the clear with the paste — a stale attachment must not ride along', async () => {
    const { deps, log } = makeDeps()
    await submitChatMessage(deps, 'hi')
    expect(log[0].data).toBe(CLEAR_BYTE)
    expect(log.some((l) => l.data.includes('200~') && l.data.includes(CLEAR_BYTE))).toBe(false)
  })

  it('holds the CR until the TUI finishes ingesting a slow image', async () => {
    // 3s of ingestion noise — far past the old blind 150ms CR.
    const { deps, log } = makeDeps({ ingestMs: 3000 })
    await submitChatMessage(deps, '/img/big.jpg what is this')

    const paste = log.find((l) => l.data.includes('200~'))!
    const cr = log.find((l) => l.data === '\r')!
    expect(cr.at - paste.at).toBeGreaterThanOrEqual(3000)
  })

  it('still waits the proven minimum when everything is instantly quiet', async () => {
    const { deps, log } = makeDeps()
    await submitChatMessage(deps, 'hi')

    const paste = log.find((l) => l.data.includes('200~'))!
    const cr = log.find((l) => l.data === '\r')!
    expect(cr.at - paste.at).toBeGreaterThanOrEqual(MIN_CR_DELAY_MS)
  })

  it('still submits when output never goes quiet (mid-turn), bounded by the cap', async () => {
    const { deps, log } = makeDeps({ alwaysNoisy: true })
    await submitChatMessage(deps, 'queued while working')

    const cr = log.find((l) => l.data === '\r')
    expect(cr).toBeDefined()
    // The dripped clear, then two settles at the cap, and never more.
    expect(cr!.at).toBeLessThanOrEqual(
      CLEAR_BURST_LEN * CLEAR_BYTE_GAP_MS + SETTLE_CAP_MS * 2 + MIN_CR_DELAY_MS,
    )
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
