import { describe, expect, it } from 'vitest'
import { buildSyntheticTerminalResponses } from './terminal-query-responder'

describe('buildSyntheticTerminalResponses', () => {
  it('responds to xterm device attribute and status report queries', () => {
    const data = '\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?6n'
    expect(buildSyntheticTerminalResponses(data)).toBe(
      '\x1b[?1;2c\x1b[>0;276;0c\x1b[0n\x1b[1;1R\x1b[?1;1R'
    )
  })

  it('responds to color queries and focus mode enablement', () => {
    const data = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\\x1b[?1004h'
    expect(buildSyntheticTerminalResponses(data)).toBe(
      '\x1b]10;rgb:e0e0/e0e0/e0e0\x1b\\\x1b]11;rgb:2424/2424/2424\x1b\\\x1b]12;rgb:e0e0/e0e0/e0e0\x1b\\\x1b[I'
    )
  })

  it('returns an empty string when no supported terminal query is present', () => {
    expect(buildSyntheticTerminalResponses('hello world')).toBe('')
  })
})
