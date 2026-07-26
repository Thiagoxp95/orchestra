import { describe, expect, it } from 'vitest'
import {
  shouldReanchor,
  STALL_INPUT_WINDOW_MS,
  STALL_REANCHOR_COOLDOWN_MS,
  STALL_SILENCE_MS,
  type StallInputs,
} from './mirror-stall'

const NOW = 1_000_000

/** A wedged stream: input 5s ago, nothing back since, page live. */
const wedged = (over: Partial<StallInputs> = {}): StallInputs => ({
  lastInputAt: NOW - 5_000,
  lastChunkAt: NOW - 6_000,
  lastReanchorAt: 0,
  visible: true,
  connected: true,
  ...over,
})

describe('shouldReanchor', () => {
  it('fires when a keystroke went unanswered past the silence window', () => {
    expect(shouldReanchor(NOW, wedged())).toBe(true)
  })

  it('holds while the silence is still shorter than the window', () => {
    expect(shouldReanchor(NOW, wedged({ lastChunkAt: NOW - (STALL_SILENCE_MS - 1) }))).toBe(false)
  })

  it('ignores an idle session that simply has nothing to say', () => {
    expect(shouldReanchor(NOW, wedged({ lastInputAt: 0, lastChunkAt: NOW - 600_000 }))).toBe(false)
  })

  it('stops caring once the input is old news', () => {
    const stale = NOW - (STALL_INPUT_WINDOW_MS + 1)
    expect(shouldReanchor(NOW, wedged({ lastInputAt: stale, lastChunkAt: stale - 1_000 }))).toBe(false)
  })

  it('treats a chunk that arrived after the keystroke as the answer', () => {
    // Typed 30s ago, echoed 20s ago, quiet since: answered, not wedged.
    expect(shouldReanchor(NOW, wedged({ lastInputAt: NOW - 10_000, lastChunkAt: NOW - 9_000 }))).toBe(false)
  })

  it('stays out of the way while the page is hidden or the socket is down', () => {
    expect(shouldReanchor(NOW, wedged({ visible: false }))).toBe(false)
    expect(shouldReanchor(NOW, wedged({ connected: false }))).toBe(false)
  })

  it('will not re-anchor twice inside the cooldown', () => {
    expect(shouldReanchor(NOW, wedged({ lastReanchorAt: NOW - 1_000 }))).toBe(false)
    expect(
      shouldReanchor(NOW, wedged({ lastReanchorAt: NOW - (STALL_REANCHOR_COOLDOWN_MS + 1) })),
    ).toBe(true)
  })
})
