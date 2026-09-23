import { describe, expect, it } from 'vitest'
import { linkAt, type LinkRow } from './terminal-links'

const COLS = 30
const screen = (...rows: (string | [string, 'wrapped'])[]) => {
  const lines: LinkRow[] = rows.map(r =>
    typeof r === 'string' ? { text: r.padEnd(COLS), wrapped: false } : { text: r[0].padEnd(COLS), wrapped: true },
  )
  return (row: number) => lines[row]
}

describe('linkAt', () => {
  it('finds a URL on one row and strips trailing punctuation', () => {
    const line = screen('Artifact(read https://a.io/x)')
    expect(linkAt(line, COLS, 0, 16)).toBe('https://a.io/x')
    expect(linkAt(line, COLS, 0, 3)).toBeNull()
    expect(linkAt(line, COLS, 0, 28)).toBeNull() // the ")"
  })

  it('stitches a soft-wrapped URL from either row', () => {
    const line = screen('see https://claude.ai/artifact', ['/WQYx then', 'wrapped'])
    expect(linkAt(line, COLS, 0, 10)).toBe('https://claude.ai/artifact/WQYx')
    expect(linkAt(line, COLS, 1, 2)).toBe('https://claude.ai/artifact/WQYx')
    expect(linkAt(line, COLS, 1, 7)).toBeNull()
  })

  it('stitches a hard-wrapped, indented continuation', () => {
    const line = screen('  go https://claude.ai/artifa', '    ct/WQYx', 'next line')
    expect(linkAt(line, COLS, 1, 5)).toBe('https://claude.ai/artifact/WQYx')
    expect(linkAt(line, COLS, 0, 8)).toBe('https://claude.ai/artifact/WQYx')
    expect(linkAt(line, COLS, 1, 1)).toBeNull() // the indent
  })

  it('does not join a short row to the next', () => {
    const line = screen('https://a.io', 'foo')
    expect(linkAt(line, COLS, 0, 3)).toBe('https://a.io')
  })
})
