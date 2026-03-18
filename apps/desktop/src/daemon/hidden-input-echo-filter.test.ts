import { describe, expect, it } from 'vitest'
import { HiddenInputEchoFilter } from './hidden-input-echo-filter'

describe('HiddenInputEchoFilter', () => {
  it('strips a hidden command echoed in one chunk', () => {
    const filter = new HiddenInputEchoFilter()
    filter.hideNextCommand("export ORCHESTRA_SESSION_ID='abc'")

    expect(
      filter.consume("$ export ORCHESTRA_SESSION_ID='abc'\r\nready\r\n")
    ).toBe('$ ready\r\n')
  })

  it('strips a hidden command echoed across multiple chunks', () => {
    const filter = new HiddenInputEchoFilter()
    filter.hideNextCommand("export ORCHESTRA_HOOK_PORT='1234'")

    expect(filter.consume('$ expo')).toBe('$ ')
    expect(filter.consume("rt ORCHESTRA_HOOK_PORT='1234'")).toBe('')
    expect(filter.consume('\r\nnext\r\n')).toBe('next\r\n')
  })

  it('leaves unrelated output untouched', () => {
    const filter = new HiddenInputEchoFilter()
    filter.hideNextCommand("export ORCHESTRA_SESSION_ID='abc'")

    expect(filter.consume('$ prompt\r\n')).toBe('$ prompt\r\n')
  })

  it('strips a command echoed with ANSI escape sequences (syntax highlighting)', () => {
    const filter = new HiddenInputEchoFilter()
    filter.hideNextCommand("export FOO='bar'")

    // Shell echoes with color codes around keywords
    const echoed = "$ \x1b[0;32mexport\x1b[0m \x1b[0;33mFOO\x1b[0m=\x1b[0;36m'bar'\x1b[0m\r\nready\r\n"
    expect(filter.consume(echoed)).toBe('$ ready\r\n')
  })

  it('strips a multi-export command with ANSI sequences', () => {
    const filter = new HiddenInputEchoFilter()
    filter.hideNextCommand("export ORCHESTRA_HOOK_PORT='62532'; export ORCHESTRA_SESSION_ID='abc-123'")

    const echoed = "$ \x1b[38;5;70mexport\x1b[0m ORCHESTRA_HOOK_PORT=\x1b[38;5;214m'62532'\x1b[0m; \x1b[38;5;70mexport\x1b[0m ORCHESTRA_SESSION_ID=\x1b[38;5;214m'abc-123'\x1b[0m\r\n$ "
    expect(filter.consume(echoed)).toBe('$ $ ')
  })

  it('handles ANSI sequences split across chunks', () => {
    const filter = new HiddenInputEchoFilter()
    filter.hideNextCommand("export A='1'")

    // First chunk ends mid-escape-sequence
    expect(filter.consume("$ \x1b[32mexport\x1b[0m A=\x1b")).toBe('$ ')
    // Second chunk completes the escape and finishes the command
    expect(filter.consume("[0m'1'\r\nok\r\n")).toBe('ok\r\n')
  })

  it('passes through ANSI sequences when no command is pending', () => {
    const filter = new HiddenInputEchoFilter()

    const colored = "\x1b[32mhello\x1b[0m world\r\n"
    expect(filter.consume(colored)).toBe(colored)
  })
})
