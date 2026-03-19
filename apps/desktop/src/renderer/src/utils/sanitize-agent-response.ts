/**
 * Sanitize agent response text for sidebar display.
 * Strips junk that Claude Code / Codex / terminal prompts sometimes emit:
 * box-drawing lines, repeated symbols, short gibberish, bare prompt chars, etc.
 */

// Lines composed entirely of non-alphanumeric decoration / separators
const JUNK_LINE_RE = /^[\s\-_=~─│┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬.…•·●⏺▶▷◆◇○∙|+*#<>\/\\^`'"!@$%&(){}\[\]:;,]+$/

// Must contain at least one sequence of 2+ letters (a real word, not "0q")
const HAS_WORD_RE = /[a-zA-Z]{2,}/

export function sanitizeAgentResponse(text: string): string | undefined {
  // Collapse whitespace and trim
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return undefined

  // If the whole string matches the junk pattern, discard it
  if (JUNK_LINE_RE.test(cleaned)) return undefined

  // Strip leading/trailing junk characters (3+ repeated non-word chars)
  const stripped = cleaned
    .replace(/^[^\w\s]{3,}\s*/, '')
    .replace(/\s*[^\w\s]{3,}$/, '')
    .trim()

  if (!stripped) return undefined

  // Must contain at least one real word (2+ consecutive letters)
  // This filters out terminal remnants like ">0q", ">1a", "$ %", etc.
  if (!HAS_WORD_RE.test(stripped)) return undefined

  return stripped
}
