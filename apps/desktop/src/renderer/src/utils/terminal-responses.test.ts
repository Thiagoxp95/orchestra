import { describe, expect, it } from 'vitest'
import { splitTerminalResponses } from './terminal-responses'

describe('splitTerminalResponses', () => {
  it('separates xterm auto-responses from user input', () => {
    const result = splitTerminalResponses('\x1b[?1;2chello\x1b]10;rgb:ffff/ffff/ffff\x07\r')

    expect(result.input).toBe('hello\r')
    expect(result.responses).toBe('\x1b[?1;2c\x1b]10;rgb:ffff/ffff/ffff\x07')
  })

  it('keeps normal user input unchanged', () => {
    expect(splitTerminalResponses('codex\r')).toEqual({
      input: 'codex\r',
      responses: '',
    })
  })
})
