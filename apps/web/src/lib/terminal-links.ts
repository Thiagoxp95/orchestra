// Find the http(s) URLs in the mirrored terminal: under a tap, and on screen.
//
// The mirror loads no xterm link addon, and xterm's own link hit-testing is
// mouse-hover driven and ignores the CSS scale used in viewer mode, so a tap on
// a URL did nothing. The caller maps the tap to a buffer cell (scale-aware) and
// asks this module what's there; it also paints a badge over every span this
// module reports for the rows in view.
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

/** The part of one URL that sits on one row: columns [start, end). */
export interface LinkSpan {
  start: number
  end: number
  url: string
  /** The URL starts on this row / ends on this row. */
  first: boolean
  last: boolean
}

type Lines = (row: number) => LinkRow | undefined

const URL_CHAR = /[\w\-.~:/?#[\]@!$&'()*+,;=%]/
const URL_RE = /https?:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+/g
const EDGE_SLACK = 2 // a hard-wrapped row may stop a column or two short of the edge
const MAX_ROWS = 6 // longest URL we stitch, in rows either side of the tap

/** Every URL span on `row`, stitched with the rows it wraps into. */
export function linksOnRow(line: Lines, cols: number, row: number): LinkSpan[] {
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
  let here = { at: 0, from: 0, to: 0 } // this row's slice: where it lands in `text`, and its columns
  for (let r = start; r <= end; r++) {
    const l = line(r)
    if (!l) return []
    // Soft-wrapped rows are full width and join as-is; a hard-wrapped
    // continuation drops its indent, and a row that hands off drops its tail.
    const from = r > start && !l.wrapped ? l.text.length - l.text.trimStart().length : 0
    const to = r < end && !line(r + 1)?.wrapped ? l.text.trimEnd().length : l.text.length
    if (r === row) here = { at: text.length, from, to }
    text += l.text.slice(from, to)
  }
  if (!text.includes('http')) return []

  const spans: LinkSpan[] = []
  const rowEnd = here.at + (here.to - here.from)
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?'")\]]+$/, '') // prose punctuation, markdown's closing paren
    const a = Math.max(m.index, here.at)
    const b = Math.min(m.index + url.length, rowEnd)
    if (a < b) spans.push({ start: here.from + a - here.at, end: here.from + b - here.at, url, first: a === m.index, last: b === m.index + url.length })
  }
  return spans
}

export function linkAt(line: Lines, cols: number, row: number, col: number): string | null {
  return linksOnRow(line, cols, row).find(s => col >= s.start && col < s.end)?.url ?? null
}

/**
 * The URL nearest a fingertip: the tapped cell first, then any within
 * `colReach` columns and `rowReach` rows of it, closest first. A cell is a few
 * pixels wide on a phone, so a tap that just misses a link should still open it.
 */
export function linkNear(line: Lines, cols: number, row: number, col: number, rowReach: number, colReach: number): string | null {
  let best: { url: string; d: number } | null = null
  for (let r = row - rowReach; r <= row + rowReach; r++) {
    for (const s of linksOnRow(line, cols, r)) {
      const dc = col < s.start ? s.start - col : col >= s.end ? col - s.end + 1 : 0
      if (dc > colReach) continue
      // A row away weighs about as much as two columns (cells are ~2:1 tall).
      const d = dc + Math.abs(r - row) * 2
      if (!best || d < best.d) best = { url: s.url, d }
    }
  }
  return best?.url ?? null
}

/** `https://github.com/owner/repo/pull/123[/files…]` → its repo and number. */
export function githubPull(url: string): { repo: string; number: number } | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/i.exec(url)
  return m ? { repo: m[1], number: Number(m[2]) } : null
}
