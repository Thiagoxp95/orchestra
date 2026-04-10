import { describe, it, expect } from 'vitest'
import { computeHasAnyClaudeRunning } from './claude-running-detector'

describe('claude-running-detector', () => {
  it('returns false for empty session list', () => {
    expect(computeHasAnyClaudeRunning([], () => [])).toBe(false)
  })

  it('returns true when any session has a process named "claude"', () => {
    const sessions = [{ id: 'a', pid: 100 }, { id: 'b', pid: 200 }]
    const getChildProcessNames = (_pid: number) => ['zsh', 'claude']
    expect(computeHasAnyClaudeRunning(sessions, getChildProcessNames)).toBe(true)
  })

  it('matches "claude" as a word, not a substring', () => {
    const sessions = [{ id: 'a', pid: 100 }]
    const getChildProcessNames = (_pid: number) => ['claude-code', 'myclaude']
    expect(computeHasAnyClaudeRunning(sessions, getChildProcessNames)).toBe(false)
  })

  it('matches when the only running command is "claude"', () => {
    const sessions = [{ id: 'a', pid: 100 }]
    expect(computeHasAnyClaudeRunning(sessions, () => ['claude'])).toBe(true)
  })

  it('matches when claude appears alongside other processes', () => {
    const sessions = [{ id: 'a', pid: 100 }]
    expect(computeHasAnyClaudeRunning(sessions, () => ['node', 'claude'])).toBe(true)
  })

  it('returns false when no session has claude', () => {
    const sessions = [{ id: 'a', pid: 100 }]
    expect(computeHasAnyClaudeRunning(sessions, () => ['zsh', 'vim'])).toBe(false)
  })

  it('only the first matching session needs to count', () => {
    const sessions = [
      { id: 'a', pid: 100 },
      { id: 'b', pid: 200 },
      { id: 'c', pid: 300 },
    ]
    const getChildProcessNames = (pid: number) => pid === 200 ? ['claude'] : ['zsh']
    expect(computeHasAnyClaudeRunning(sessions, getChildProcessNames)).toBe(true)
  })
})
