// Pure helpers for the mobile terminal accessory key bar.
// Ctrl/Shift/Alt are sticky modifiers that combine with the NEXT key — either a
// special key from the bar or a printable char typed on the device keyboard.

export interface Modifiers {
  ctrl: boolean
  shift: boolean
  alt: boolean
}

export const NO_MODS: Modifiers = { ctrl: false, shift: false, alt: false }

const SPECIAL: Record<string, string> = {
  enter: '\r',
  tab: '\t',
  esc: '\x1b',
  space: ' ',
  backspace: '\x7f',
  // Mac's Cmd+Backspace ("delete to start of line"). Ctrl+U is what both shells
  // and the agent TUIs bind that to, so holding Backspace on the bar kills a
  // whole line instead of nibbling one character at a time.
  deleteline: '\x15',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
}

/** Bytes for a named special key. Modifiers do not alter these in v1. */
export function specialKeyBytes(key: string): string {
  return SPECIAL[key] ?? ''
}

/** Apply armed modifiers to a single printable character. */
export function charBytes(ch: string, mods: Modifiers): string {
  let c = ch
  if (mods.shift) c = c.toUpperCase()
  if (mods.ctrl) {
    const lower = c.toLowerCase()
    const code = lower.charCodeAt(0)
    if (code >= 97 && code <= 122) {
      c = String.fromCharCode(code - 96) // a -> \x01 ... z -> \x1a
    } else if (c === ' ') {
      c = '\x00'
    }
    // Non-letter ctrl combos pass through unchanged.
  }
  if (mods.alt) c = '\x1b' + c
  return c
}

/** True if any modifier is armed. */
export function anyModifier(mods: Modifiers): boolean {
  return mods.ctrl || mods.shift || mods.alt
}
