import { describe, expect, it } from 'vitest'
import { githubPull, linkAt, linkNear, linksOnRow, type LinkRow } from './terminal-links'

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

describe('linksOnRow', () => {
  it('reports each row\'s columns of a wrapped URL', () => {
    const line = screen('  go https://claude.ai/artifa', '    ct/WQYx.', 'next line')
    expect(linksOnRow(line, COLS, 0)).toEqual([{ start: 5, end: 29, url: 'https://claude.ai/artifact/WQYx', first: true, last: false }])
    expect(linksOnRow(line, COLS, 1)).toEqual([{ start: 4, end: 11, url: 'https://claude.ai/artifact/WQYx', first: false, last: true }])
    expect(linksOnRow(line, COLS, 2)).toEqual([])
  })
})

describe('linkNear', () => {
  const line = screen('ready: https://a.io/x ok', 'second row')
  it('opens a link the tap just missed', () => {
    expect(linkNear(line, COLS, 0, 5, 1, 2)).toBe('https://a.io/x') // two columns short
    expect(linkNear(line, COLS, 1, 10, 1, 2)).toBe('https://a.io/x') // the row below
    expect(linkNear(line, COLS, 1, 0, 1, 2)).toBeNull() // too far left
  })
})

describe('githubPull', () => {
  it('reads a PR link and nothing else', () => {
    expect(githubPull('https://github.com/tedy-app/tedy/pull/4895')).toEqual({ repo: 'tedy-app/tedy', number: 4895 })
    expect(githubPull('https://github.com/a/b/pull/7/files#diff')).toEqual({ repo: 'a/b', number: 7 })
    expect(githubPull('https://github.com/a/b/issues/7')).toBeNull()
    expect(githubPull('https://github.com/a/b/pull/7x')).toBeNull()
  })
})
