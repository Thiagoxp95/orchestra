import { describe, expect, it } from 'vitest'
import { shouldFinalize } from './dictation-finalize'

const base = { ended: true, expected: null as number | null, received: 0, endedAt: 1_000 }
const NOW = 1_000

describe('shouldFinalize', () => {
  it('never finalizes while the phone is still holding the button', () => {
    expect(shouldFinalize({ ...base, ended: false, endedAt: null }, 0, NOW)).toBe(false)
  })

  it('waits for every chunk the phone said it uploaded', () => {
    // The tail of an utterance is the most common thing to lose: an empty poll
    // means "this read didn't see the rows", not "the phone is done sending".
    expect(shouldFinalize({ ...base, expected: 10, received: 7 }, 0, NOW)).toBe(false)
  })

  it('finalizes once the expected chunk count has been fed', () => {
    expect(shouldFinalize({ ...base, expected: 10, received: 10 }, 0, NOW)).toBe(true)
  })

  it('finalizes when more chunks arrived than expected', () => {
    expect(shouldFinalize({ ...base, expected: 10, received: 11 }, 0, NOW)).toBe(true)
  })

  it('gives up waiting after the drain grace period', () => {
    // Phone died mid-upload — finalize what we have rather than hang forever.
    expect(shouldFinalize({ ...base, expected: 10, received: 7 }, 0, NOW + 4_000)).toBe(true)
  })

  it('falls back to an empty drain for clients that report no count', () => {
    expect(shouldFinalize({ ...base, expected: null, received: 5 }, 0, NOW)).toBe(true)
    expect(shouldFinalize({ ...base, expected: null, received: 5 }, 3, NOW)).toBe(false)
  })
})
