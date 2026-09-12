import { describe, expect, it } from 'vitest'
import { charBytes, specialKeyBytes, anyModifier, NO_MODS, inputBytes, createModifierKeys } from './keyboard'

describe('charBytes', () => {
  it('Ctrl+c -> ETX (\\x03)', () => {
    expect(charBytes('c', { ctrl: true, shift: false, alt: false, meta: false })).toBe('\x03')
  })
  it('Ctrl+a -> \\x01', () => {
    expect(charBytes('a', { ctrl: true, shift: false, alt: false, meta: false })).toBe('\x01')
  })
  it('Shift uppercases', () => {
    expect(charBytes('k', { ctrl: false, shift: true, alt: false, meta: false })).toBe('K')
  })
  it('Alt prefixes ESC', () => {
    expect(charBytes('x', { ctrl: false, shift: false, alt: true, meta: false })).toBe('\x1bx')
  })
  it('Ctrl+Alt+d -> ESC + \\x04', () => {
    expect(charBytes('d', { ctrl: true, shift: false, alt: true, meta: false })).toBe('\x1b\x04')
  })
  it('no modifiers passes through', () => {
    expect(charBytes('g', NO_MODS)).toBe('g')
  })
})

describe('specialKeyBytes', () => {
  it('Option+Up opens the queued question shortcut', () => {
    expect(specialKeyBytes('up', { ...NO_MODS, alt: true, meta: false })).toBe('\x1b[1;3A')
  })
  it('combines modifiers on arrows and editing keys', () => {
    expect(specialKeyBytes('left', { ...NO_MODS, ctrl: true, shift: true })).toBe('\x1b[1;6D')
    expect(specialKeyBytes('down', { ...NO_MODS, meta: true })).toBe('\x1b[1;9B')
    expect(specialKeyBytes('tab', { ...NO_MODS, shift: true })).toBe('\x1b[Z')
    expect(specialKeyBytes('backspace', { ...NO_MODS, alt: true, meta: false })).toBe('\x1b\x7f')
    expect(specialKeyBytes('backspace', { ...NO_MODS, meta: true })).toBe('\x15')
    expect(specialKeyBytes('space', { ...NO_MODS, ctrl: true })).toBe('\x00')
    expect(specialKeyBytes('enter', { ...NO_MODS, alt: true, meta: false })).toBe('\x1b\r')
  })
  it('arrows', () => {
    expect(specialKeyBytes('up')).toBe('\x1b[A')
    expect(specialKeyBytes('down')).toBe('\x1b[B')
    expect(specialKeyBytes('left')).toBe('\x1b[D')
    expect(specialKeyBytes('right')).toBe('\x1b[C')
  })
  it('enter/tab/esc/space/backspace', () => {
    expect(specialKeyBytes('enter')).toBe('\r')
    expect(specialKeyBytes('tab')).toBe('\t')
    expect(specialKeyBytes('esc')).toBe('\x1b')
    expect(specialKeyBytes('space')).toBe(' ')
    expect(specialKeyBytes('backspace')).toBe('\x7f')
  })
  it('deleteline -> Ctrl+U (Cmd+Backspace on the Mac)', () => {
    expect(specialKeyBytes('deleteline')).toBe('\x15')
  })
  it('unknown -> empty', () => {
    expect(specialKeyBytes('nope')).toBe('')
  })
})

describe('device keyboard input', () => {
  it('combines on-screen Option with normal, application, and modified arrows', () => {
    const mods = { ...NO_MODS, alt: true, meta: false }
    expect(inputBytes('\x1b[A', mods)).toBe('\x1b[1;3A')
    expect(inputBytes('\x1bOA', mods)).toBe('\x1b[1;3A')
    expect(inputBytes('\x1b[1;5A', mods)).toBe('\x1b[1;7A')
  })
  it('handles Command editing and Meta characters, without modifying pasted text', () => {
    const mods = { ...NO_MODS, meta: true }
    expect(anyModifier(mods)).toBe(true)
    expect(inputBytes('\x7f', mods)).toBe('\x15')
    expect(inputBytes('x', mods)).toBe('\x1bx')
    expect(inputBytes('pasted text', mods)).toBe('pasted text')
  })
})

describe('modifier gestures', () => {
  it('keeps Option held across keys, then clears it on release', () => {
    const keys = createModifierKeys()
    keys.press('alt', 1)
    expect(specialKeyBytes('up', keys.current())).toBe('\x1b[1;3A')
    keys.consume()
    expect(specialKeyBytes('down', keys.current())).toBe('\x1b[1;3B')
    keys.release(1)
    expect(anyModifier(keys.current())).toBe(false)
  })
  it('arms a tap for one key and allows tapping again to disarm', () => {
    const keys = createModifierKeys()
    keys.press('alt', 1); keys.release(1)
    expect(keys.current().alt).toBe(true)
    keys.consume()
    expect(anyModifier(keys.current())).toBe(false)
    keys.toggle('meta'); keys.toggle('meta')
    expect(anyModifier(keys.current())).toBe(false)
  })
  it('combines two fingers and clears cancelled or abandoned holds', () => {
    const keys = createModifierKeys()
    keys.press('ctrl', 1); keys.press('alt', 2)
    expect(charBytes('c', keys.current())).toBe('\x1b\x03')
    keys.consume(); keys.release(2, true)
    expect(charBytes('c', keys.current())).toBe('\x03')
    keys.reset()
    keys.release(1)
    expect(anyModifier(keys.current())).toBe(false)
  })
  it('does not latch a long hold released without a key', () => {
    let now = 0
    const keys = createModifierKeys(undefined, () => now)
    keys.press('alt', 1)
    now = 1000
    keys.release(1)
    expect(anyModifier(keys.current())).toBe(false)
  })
})

describe('anyModifier', () => {
  it('false for none', () => {
    expect(anyModifier(NO_MODS)).toBe(false)
  })
  it('true when ctrl armed', () => {
    expect(anyModifier({ ctrl: true, shift: false, alt: false, meta: false })).toBe(true)
  })
})
