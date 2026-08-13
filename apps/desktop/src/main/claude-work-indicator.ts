import type { ClaudeWorkState } from '../shared/types'

export type { ClaudeWorkState }

export interface TitleParseResult {
  remainder: string
  titles: string[]
}

const OSC_PREFIX = '\u001b]'
const ST = '\u001b\\'
const BEL = '\u0007'
const CLAUDE_IDLE_GLYPH = '✳'
const BRAILLE_SPINNER_RANGE_START = 0x2800
const BRAILLE_SPINNER_RANGE_END = 0x28ff
// claude v2.1.228 swapped the title spinner from braille to circle-halves
// (observed ◐/◑ alternating in live titles; ◒/◓ are the other two phases of
// the standard cycle). Idle is still ✳.
const CIRCLE_SPINNER_RANGE_START = 0x25d0
const CIRCLE_SPINNER_RANGE_END = 0x25d3

export function extractTerminalTitles(chunk: string, remainder = ''): TitleParseResult {
  const input = remainder + chunk
  const titles: string[] = []
  let cursor = 0

  while (cursor < input.length) {
    const oscStart = input.indexOf(OSC_PREFIX, cursor)
    if (oscStart === -1) {
      return { remainder: '', titles }
    }

    const bodyStart = oscStart + OSC_PREFIX.length
    const belIndex = input.indexOf(BEL, bodyStart)
    const stIndex = input.indexOf(ST, bodyStart)
    const endIndex = [belIndex, stIndex].filter((index) => index !== -1).sort((a, b) => a - b)[0]

    if (endIndex === undefined) {
      return { remainder: input.slice(oscStart), titles }
    }

    const sequenceBody = input.slice(bodyStart, endIndex)
    const separatorIndex = sequenceBody.indexOf(';')
    if (separatorIndex !== -1) {
      const code = sequenceBody.slice(0, separatorIndex)
      const title = sequenceBody.slice(separatorIndex + 1)
      if (code === '0' || code === '2') {
        titles.push(title)
      }
    }

    cursor = endIndex + (endIndex === stIndex ? ST.length : BEL.length)
  }

  return { remainder: '', titles }
}

export function titleToClaudeWorkState(title: string): ClaudeWorkState | null {
  const trimmed = title.trim()
  if (!trimmed) return null
  const firstChar = Array.from(trimmed)[0]
  if (!firstChar) return null
  if (firstChar === CLAUDE_IDLE_GLYPH) return 'idle'
  const codePoint = firstChar.codePointAt(0) ?? 0
  if (codePoint >= BRAILLE_SPINNER_RANGE_START && codePoint <= BRAILLE_SPINNER_RANGE_END) {
    return 'working'
  }
  if (codePoint >= CIRCLE_SPINNER_RANGE_START && codePoint <= CIRCLE_SPINNER_RANGE_END) {
    return 'working'
  }
  return null
}

export function getClaudeWorkStateFromChunk(
  chunk: string,
  remainder = ''
): { remainder: string; state: ClaudeWorkState | null } {
  const parsed = extractTerminalTitles(chunk, remainder)
  let state: ClaudeWorkState | null = null

  for (const title of parsed.titles) {
    const nextState = titleToClaudeWorkState(title)
    if (nextState) state = nextState
  }

  return { remainder: parsed.remainder, state }
}

/**
 * How long an idle title must stand unchallenged before it counts as idle.
 *
 * `✳` is NOT an idle-only glyph. Measured against claude 2.1.231, it is also a
 * frame of the working spinner: live titles cycle `◐ ◑ ✳ ◐ ◑ ✳ …` about once a
 * second for the whole turn. It happens to also be the glyph the title rests on
 * when the turn really ends, so the glyph alone cannot tell the two apart —
 * only its persistence can. A mid-turn `✳` is followed by a spinner frame
 * within ~1s; a finished turn stops emitting titles altogether.
 *
 * So an idle title is held for this long and dropped if any working frame
 * arrives behind it. 4s clears every observed blip with margin and costs a
 * finished turn at most 4s of notification latency.
 */
export const CLAUDE_IDLE_SETTLE_MS = 4000

export function isSessionWorking(
  processStatus: string,
  claudeWorkState: ClaudeWorkState | undefined
): boolean {
  if (processStatus === 'claude') return claudeWorkState === 'working'
  return false
}

// Claude TUI's picker footer — appears at the bottom of the screen when Claude
// is presenting an interactive numbered menu and waiting for the user to
// select. Distinct enough to use as a "needs user input" signal: codex-cli's
// picker uses different copy, the user's own typed text wouldn't include
// the U+00B7 separator or the arrow glyphs, and the three-part pattern
// ("select / navigate / cancel") is unique to Claude Code's prompt.
const CLAUDE_PICKER_FOOTER_RE = /Enter to select\s*[·•]\s*↑\/↓ to navigate\s*[·•]\s*Esc to cancel/

export function chunkContainsClaudePickerFooter(chunk: string): boolean {
  return CLAUDE_PICKER_FOOTER_RE.test(chunk)
}
