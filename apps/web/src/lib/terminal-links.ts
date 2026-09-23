// Find the http(s) URL under a tapped terminal cell.
//
// The mirror loads no xterm link addon, and xterm's own link hit-testing is
// mouse-hover driven and ignores the CSS scale used in viewer mode, so a tap on
// a URL did nothing. The caller maps the tap to a buffer cell (scale-aware) and
// asks this module what's there.
//
// A URL can span rows two ways: xterm soft-wraps it (`wrapped`), or the TUI
// hard-wraps it itself (Ink breaks long words at the box width and indents the
// continuation). The second is inferred: a row whose text runs to the right
// edge and ends in URL characters continues on the next row, minus its indent.

export interface LinkRow {
  /** One code unit per cell (index === column). */
  text: string
  /** xterm's isWrapped: this row soft-continues the previous one. */
  wrapped: boolean
}

const URL_CHAR = /[\w\-.~:/?#[\]@!$&'()*+,;=%]/
const URL_RE = /https?:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+/g
const EDGE_SLACK = 2 // a hard-wrapped row may stop a column or two short of the edge
const MAX_ROWS = 6 // longest URL we stitch, in rows either side of the tap

export function urlAt(text: string, index: number): string | null {
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?'")\]]+$/, '') // prose punctuation, markdown's closing paren
    if (index >= m.index && index < m.index + url.length) return url
  }
  return null
}

export function linkAt(line: (row: number) => LinkRow | undefined, cols: number, row: number, col: number): string | null {
  const joins = (a: number, b: number) => {
    const la = line(a)
    const lb = line(b)
    if (!la || !lb) return false
    if (lb.wrapped) return true
    const end = la.text.trimEnd()
    const next = lb.text.trimStart()
    return end.length >= cols - EDGE_SLACK && URL_CHAR.test(end.at(-1) ?? '') && URL_CHAR.test(next[0] ?? '')
  }
  let start = row
  while (start > row - MAX_ROWS && joins(start - 1, start)) start--
  let end = row
  while (end < row + MAX_ROWS && joins(end, end + 1)) end++

  let text = ''
  let index = -1
  for (let r = start; r <= end; r++) {
    const l = line(r)
    if (!l) return null
    // Soft-wrapped rows are full width and join as-is; a hard-wrapped
    // continuation drops its indent, and a row that hands off drops its tail.
    const from = r > start && !l.wrapped ? l.text.length - l.text.trimStart().length : 0
    const to = r < end && !line(r + 1)?.wrapped ? l.text.trimEnd().length : l.text.length
    if (r === row) {
      if (col < from || col >= to) return null
      index = text.length + col - from
    }
    text += l.text.slice(from, to)
  }
  return urlAt(text, index)
}
