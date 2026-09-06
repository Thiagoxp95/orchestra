import { describe, expect, it } from 'vitest'
import { charBytes, specialKeyBytes, anyModifier, NO_MODS } from './keyboard'

describe('charBytes', () => {
  it('Ctrl+c -> ETX (\\x03)', () => {
    expect(charBytes('c', { ctrl: true, shift: false, alt: false })).toBe('\x03')
  })
  it('Ctrl+a -> \\x01', () => {
    expect(charBytes('a', { ctrl: true, shift: false, alt: false })).toBe('\x01')
  })
  it('Shift uppercases', () => {
    expect(charBytes('k', { ctrl: false, shift: true, alt: false })).toBe('K')
  })
  it('Alt prefixes ESC', () => {
    expect(charBytes('x', { ctrl: false, shift: false, alt: true })).toBe('\x1bx')
  })
  it('Ctrl+Alt+d -> ESC + \\x04', () => {
    expect(charBytes('d', { ctrl: true, shift: false, alt: true })).toBe('\x1b\x04')
  })
  it('no modifiers passes through', () => {
    expect(charBytes('g', NO_MODS)).toBe('g')
  })
})

describe('specialKeyBytes', () => {
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

describe('anyModifier', () => {
  it('false for none', () => {
    expect(anyModifier(NO_MODS)).toBe(false)
  })
  it('true when ctrl armed', () => {
    expect(anyModifier({ ctrl: true, shift: false, alt: false })).toBe(true)
  })
})
