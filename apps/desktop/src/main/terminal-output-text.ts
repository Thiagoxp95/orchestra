// terminal-output-text.ts
// Pure text-cleaning helpers for terminal output. Kept free of electron imports
// so the unit tests exercise the same code the app ships instead of a copy.

// Cursor-movement CSI sequences that represent visual spacing — replaced with
// a space so that text positioned via cursor commands retains word boundaries.
const CURSOR_MOVE_RE = /\x1b\[\d*[CGHf]|\x1b\[\d+;\d+[Hf]/g

// Strip ANSI escape sequences, OSC sequences, and control characters.
// The CSI branch follows the real grammar: parameter bytes 0x30-0x3f (which
// include the `<`, `>` and `=` used by mouse reports and private-mode
// sequences), then intermediate bytes 0x20-0x2f, then a final byte 0x40-0x7e.
// A narrower `[0-9;?]*[A-Za-z]` leaves the tail of anything parameterised with
// `<` behind, which is how `[<35;107;21M` ended up in sidebar labels.
const ANSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[\x20-\x7e]|\r/g

// Nerd Font / powerline glyphs live in the Unicode private use areas. They mean
// nothing outside the terminal's own font, and render as tofu boxes in the
// sidebar and in OS notifications.
const PRIVATE_USE_RE = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu

export function stripAnsi(data: string): string {
  return data
    .replace(CURSOR_MOVE_RE, ' ')  // preserve spacing from cursor positioning
    .replace(ANSI_RE, '')
    .replace(PRIVATE_USE_RE, '')   // powerline/Nerd Font icons render as tofu
    .replace(/ {2,}/g, ' ')        // collapse runs of spaces from replacements
}

/** Lines that carry no information worth showing as a session preview. */
export function isTrivialLine(line: string): boolean {
  if (line.length < 3) return true
  // Box-drawing / separator lines
  if (/^[─│┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬\-=+|_\s.…●⏺▶▷◆◇○•∙·]+$/.test(line)) return true
  // Bare prompt characters
  if (/^[❯❮$%>→]\s*$/.test(line)) return true
  // ANSI remnants that weren't fully stripped
  if (/^\x1b/.test(line)) return true
  // Lines without a real word (2+ consecutive letters) — filters terminal
  // noise like ">0q"
  if (!/[a-zA-Z]{2,}/.test(line)) return true
  return false
}

/**
 * Extract the last meaningful line from the buffer.
 * Skips empty lines, box-drawing, prompts, and very short lines.
 */
export function extractLastMeaningfulText(buffer: string): string {
  const lines = buffer.split('\n')
  // Walk backwards through last 100 lines to find meaningful text
  const limit = Math.max(0, lines.length - 100)
  for (let i = lines.length - 1; i >= limit; i--) {
    const line = lines[i].trim()
    if (!line) continue
    if (isTrivialLine(line)) continue
    return line.slice(0, 200)
  }
  return ''
}
