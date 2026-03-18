import { describe, it, expect } from 'vitest'
// Test the core logic by importing internal functions
// We test feedTerminalOutput and getLastMeaningfulLine via the module

// Since the module uses BrowserWindow, we test the pure logic by extracting
// the strip and extract functions inline here (same logic as the module)

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[\x20-\x7e]|\r/g

function stripAnsi(data: string): string {
  return data.replace(ANSI_RE, '')
}

function isTrivialLine(line: string): boolean {
  if (/^[─│┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬\-=+|_\s.…●⏺▶▷◆◇○•∙·]+$/.test(line)) return true
  if (/^[❯❮$%>→]\s*$/.test(line)) return true
  if (/^\x1b/.test(line)) return true
  if (line.length < 3) return true
  return false
}

function extractLastMeaningfulText(buffer: string): string {
  const lines = buffer.split('\n')
  const limit = Math.max(0, lines.length - 100)
  for (let i = lines.length - 1; i >= limit; i--) {
    const line = lines[i].trim()
    if (!line) continue
    if (isTrivialLine(line)) continue
    return line.slice(0, 200)
  }
  return ''
}

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
