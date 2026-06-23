import { describe, expect, it } from 'vitest'
import { altScrollSequence } from './terminal-scroll'

describe('altScrollSequence', () => {
  it('sends SGR wheel-up when the program tracks the mouse', () => {
    expect(altScrollSequence({ mouseTracking: true, applicationCursor: false }, true)).toBe('\x1b[<64;1;1M')
  })

  it('sends SGR wheel-down when the program tracks the mouse', () => {
    expect(altScrollSequence({ mouseTracking: true, applicationCursor: false }, false)).toBe('\x1b[<65;1;1M')
  })

  it('falls back to arrow keys when the mouse is not tracked', () => {
    expect(altScrollSequence({ mouseTracking: false, applicationCursor: false }, true)).toBe('\x1b[A')
    expect(altScrollSequence({ mouseTracking: false, applicationCursor: false }, false)).toBe('\x1b[B')
  })

  it('uses application-cursor arrow encoding when DECCKM is on', () => {
    expect(altScrollSequence({ mouseTracking: false, applicationCursor: true }, true)).toBe('\x1bOA')
    expect(altScrollSequence({ mouseTracking: false, applicationCursor: true }, false)).toBe('\x1bOB')
  })

  it('prefers mouse-wheel over arrows even with application cursor keys on', () => {
    expect(altScrollSequence({ mouseTracking: true, applicationCursor: true }, true)).toBe('\x1b[<64;1;1M')
  })
})
