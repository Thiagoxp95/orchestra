import { describe, expect, it } from 'vitest'
import {
  extractTerminalTitles,
  getClaudeWorkStateFromChunk,
  isSessionWorking,
  titleToClaudeWorkState,
} from './claude-work-indicator'

describe('extractTerminalTitles', () => {
  it('extracts OSC 0 and OSC 2 titles', () => {
    const input = '\u001b]0;✳ Claude Code\u0007hello\u001b]2;other title\u001b\\'
    expect(extractTerminalTitles(input)).toEqual({
      remainder: '',
      titles: ['✳ Claude Code', 'other title'],
    })
  })

  it('preserves an incomplete OSC sequence as remainder', () => {
    expect(extractTerminalTitles('\u001b]0;⠂ Claude')).toEqual({
      remainder: '\u001b]0;⠂ Claude',
      titles: [],
    })
  })

  it('supports chunked OSC parsing', () => {
    const first = getClaudeWorkStateFromChunk('\u001b]0;⠂ Claude')
    expect(first).toEqual({
      remainder: '\u001b]0;⠂ Claude',
      state: null,
    })

    const second = getClaudeWorkStateFromChunk(' Code\u0007', first.remainder)
    expect(second).toEqual({
      remainder: '',
      state: 'working',
    })
  })
})

describe('titleToClaudeWorkState', () => {
  it('maps the static Claude title to idle', () => {
    expect(titleToClaudeWorkState('✳ Claude Code')).toBe('idle')
  })

  it('maps animated Claude titles to working', () => {
    expect(titleToClaudeWorkState('⠂ Claude Code')).toBe('working')
    expect(titleToClaudeWorkState('⠐ Claude Code')).toBe('working')
  })

  it('ignores unrelated titles', () => {
    expect(titleToClaudeWorkState('hello')).toBeNull()
    expect(titleToClaudeWorkState('')).toBeNull()
  })
})

describe('isSessionWorking', () => {
  it('treats only claude working state as busy', () => {
    expect(isSessionWorking('claude', 'working')).toBe(true)
    expect(isSessionWorking('claude', 'idle')).toBe(false)
    expect(isSessionWorking('claude', undefined)).toBe(false)
  })

  it('does not treat codex sessions as Claude-working', () => {
    expect(isSessionWorking('codex', undefined)).toBe(false)
    expect(isSessionWorking('codex', 'idle')).toBe(false)
  })

  it('treats terminal sessions as idle', () => {
    expect(isSessionWorking('terminal', undefined)).toBe(false)
  })
})
