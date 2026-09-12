// Pure helpers for the mobile terminal accessory key bar.
// Modifiers combine with bar keys and device keyboard input.

export interface Modifiers {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

export const NO_MODS: Modifiers = { ctrl: false, shift: false, alt: false, meta: false }

const modifierBits = (mods: Modifiers) =>
  (mods.shift ? 1 : 0) | (mods.alt ? 2 : 0) | (mods.ctrl ? 4 : 0) | (mods.meta ? 8 : 0)

const ARROWS: Record<string, string> = { up: 'A', down: 'B', left: 'D', right: 'C' }

const SPECIAL: Record<string, string> = {
  enter: '\r',
  tab: '\t',
  esc: '\x1b',
  space: ' ',
  backspace: '\x7f',
  // Mac's Cmd+Backspace ("delete to start of line"). Ctrl+U is what both shells
  // and the agent TUIs bind that to, so Command+Backspace on the bar deletes to the
  // beginning of the line.
  deleteline: '\x15',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
}

/** Bytes for a named special key, including xterm's modified cursor sequences. */
export function specialKeyBytes(key: string, mods: Modifiers = NO_MODS): string {
  const arrow = ARROWS[key]
  if (arrow && anyModifier(mods)) {
    const modifier = 1 + modifierBits(mods)
    return `\x1b[1;${modifier}${arrow}`
  }
  if (key === 'tab' && mods.shift) return '\x1b[Z'
  if (key === 'backspace' && mods.meta) return SPECIAL.deleteline
  if (key === 'backspace') return (mods.alt ? '\x1b' : '') + (mods.ctrl ? '\b' : '\x7f')
  if (key === 'space') return charBytes(' ', mods)
  if (['enter', 'tab', 'esc'].includes(key)) return (mods.alt || mods.meta ? '\x1b' : '') + SPECIAL[key]
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
  // Command is terminal Meta; native macOS application shortcuts do not travel
  // over the PTY. Cmd+Backspace is explicitly mapped to the line-editing command.
  if (mods.alt || mods.meta) c = '\x1b' + c
  return c
}

/** True if any modifier is armed. */
export function anyModifier(mods: Modifiers): boolean {
  return mods.ctrl || mods.shift || mods.alt || mods.meta
}

/** Apply bar modifiers to xterm input without treating a paste as one shortcut. */
export function inputBytes(data: string, mods: Modifiers): string {
  if (!anyModifier(mods)) return data
  const arrow = data.startsWith('\x1b') ? /^(?:\[(?:1;(\d+))?|O)([ABCD])$/.exec(data.slice(1)) : null
  if (arrow) {
    const bits = (Number(arrow[1] ?? 1) - 1) | modifierBits(mods)
    return `\x1b[1;${bits + 1}${arrow[2]}`
  }
  const special = { '\r': 'enter', '\t': 'tab', '\x1b': 'esc', '\x7f': 'backspace' }[data]
  if (special) return specialKeyBytes(special, mods)
  return data.length === 1 ? charBytes(data, mods) : data
}

/** Synchronous state keeps multi-touch chords correct between React renders. */
export function createModifierKeys(onChange?: (mods: Modifiers) => void, now = Date.now) {
  let latched = { ...NO_MODS }
  const held = new Map<number, { name: keyof Modifiers; used: boolean; started: number; wasLatched: boolean }>()
  const current = (): Modifiers => {
    const mods = { ...latched }
    for (const press of held.values()) mods[press.name] = true
    return mods
  }
  const notify = () => onChange?.(current())
  return {
    current,
    press(name: keyof Modifiers, pointerId: number) {
      held.set(pointerId, { name, used: false, started: now(), wasLatched: latched[name] })
      notify()
    },
    release(pointerId: number, cancelled = false) {
      const press = held.get(pointerId)
      if (!press) return
      held.delete(pointerId)
      latched[press.name] = !cancelled && !press.used && now() - press.started < 300 && !press.wasLatched
      notify()
    },
    toggle(name: keyof Modifiers) {
      latched[name] = !latched[name]
      notify()
    },
    consume() {
      latched = { ...NO_MODS }
      for (const press of held.values()) press.used = true
      notify()
    },
    reset() {
      latched = { ...NO_MODS }
      held.clear()
      notify()
    },
  }
}
