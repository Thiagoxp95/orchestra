import { describe, it, expect } from 'vitest'
// terminal-output-buffer.ts imports electron, so the pure text helpers it uses
// live in terminal-output-text.ts and are tested directly here.
import { extractLastMeaningfulText, stripAnsi } from './terminal-output-text'

describe('stripAnsi', () => {
  it('strips CSI color codes', () => {
    expect(stripAnsi('\x1b[32mHello\x1b[0m world')).toBe('Hello world')
  })

  it('strips OSC title sequences', () => {
    expect(stripAnsi('\x1b]0;My Title\x07some text')).toBe('some text')
    expect(stripAnsi('\x1b]2;Another Title\x1b\\text here')).toBe('text here')
  })

  it('strips cursor movement sequences', () => {
    expect(stripAnsi('\x1b[2Ahello\x1b[10C world')).toBe('hello world')
  })

  it('strips carriage returns', () => {
    expect(stripAnsi('line1\rline2')).toBe('line1line2')
  })

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('plain text here')).toBe('plain text here')
  })

  it('handles complex ANSI sequences', () => {
    const input = '\x1b[1;34m⏺\x1b[0m I will help you with that.'
    expect(stripAnsi(input)).toBe('⏺ I will help you with that.')
  })

  it('strips CSI sequences with non-numeric parameter bytes', () => {
    // SGR mouse reports and private-mode sequences use `<`, `>` and `=`
    expect(stripAnsi('\x1b[<35;107;21Mhello')).toBe('hello')
    expect(stripAnsi('\x1b[>4;2mhi')).toBe('hi')
    expect(stripAnsi('\x1b[?25lprompt\x1b[?25h')).toBe('prompt')
  })

  it('strips private-use glyphs that render as tofu outside the terminal', () => {
    const powerlinePrompt = '\u{E0B0} ~/orchestra \u{E0B0} on \u{E0A0} main'
    expect(stripAnsi(powerlinePrompt)).toBe(' ~/orchestra on main')
    expect(stripAnsi('\u{F0A0F} deploy')).toBe(' deploy')
  })
})

describe('extractLastMeaningfulText', () => {
  it('returns the last non-trivial line', () => {
    const buffer = 'Some response text\n\n$ \n'
    expect(extractLastMeaningfulText(buffer)).toBe('Some response text')
  })

  it('skips box-drawing characters', () => {
    const buffer = 'The answer is 42\n─────────────\n\n'
    expect(extractLastMeaningfulText(buffer)).toBe('The answer is 42')
  })

  it('skips bare prompts', () => {
    const buffer = 'Done with changes\n❯ \n$ \n'
    expect(extractLastMeaningfulText(buffer)).toBe('Done with changes')
  })

  it('skips very short lines', () => {
    const buffer = 'Here is the result\nok\n\n'
    expect(extractLastMeaningfulText(buffer)).toBe('Here is the result')
  })

  it('returns empty for empty buffer', () => {
    expect(extractLastMeaningfulText('')).toBe('')
  })

  it('returns empty for only trivial lines', () => {
    expect(extractLastMeaningfulText('$ \n❯ \n──\n')).toBe('')
  })

  it('truncates long lines to 200 chars', () => {
    const longLine = 'a'.repeat(300)
    expect(extractLastMeaningfulText(longLine).length).toBe(200)
  })

  it('handles Claude-style output', () => {
    const buffer = [
      '⏺ Reading file src/main.ts',
      '',
      '⏺ I have updated the file with the new configuration.',
      '',
      '$ ',
    ].join('\n')
    // The ⏺ prefix from Claude is included since it's part of the visible line
    expect(extractLastMeaningfulText(buffer)).toBe(
      '⏺ I have updated the file with the new configuration.'
    )
  })
})
