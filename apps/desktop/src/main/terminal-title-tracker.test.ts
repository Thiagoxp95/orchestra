import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  feedRawData,
  isTitleAnimating,
  getLastTitle,
  clearSession,
  clearAll,
} from './terminal-title-tracker'

describe('terminal-title-tracker', () => {
  beforeEach(() => {
    clearAll()
  })

  afterEach(() => {
    clearAll()
  })

  it('extracts OSC 0 title from raw data', () => {
    feedRawData('s1', '\x1b]0;My Title\x07')
    expect(getLastTitle('s1')).toBe('My Title')
  })

  it('extracts OSC 2 title from raw data', () => {
    feedRawData('s1', '\x1b]2;Window Title\x07')
    expect(getLastTitle('s1')).toBe('Window Title')
  })

  it('extracts title terminated by ST (ESC backslash)', () => {
    feedRawData('s1', '\x1b]0;Title ST\x1b\\')
    expect(getLastTitle('s1')).toBe('Title ST')
  })

  it('extracts title embedded in other data', () => {
    feedRawData('s1', 'some text\x1b]0;Embedded\x07more text')
    expect(getLastTitle('s1')).toBe('Embedded')
  })

  it('detects title animation when title changes rapidly', () => {
    feedRawData('s1', '\x1b]0;⠂ Claude\x07')
    feedRawData('s1', '\x1b]0;⠐ Claude\x07')
    expect(isTitleAnimating('s1')).toBe(true)
  })

  it('returns false for animation when title has not changed', () => {
    feedRawData('s1', '\x1b]0;Static Title\x07')
    expect(isTitleAnimating('s1')).toBe(false)
  })

  it('returns false for animation when no title set', () => {
    expect(isTitleAnimating('s1')).toBe(false)
  })

  it('detects animation stopping after timeout', () => {
    vi.useFakeTimers()
    feedRawData('s1', '\x1b]0;⠂ Claude\x07')
    feedRawData('s1', '\x1b]0;⠐ Claude\x07')
    expect(isTitleAnimating('s1')).toBe(true)

    vi.advanceTimersByTime(1500)
    expect(isTitleAnimating('s1')).toBe(false)
    vi.useRealTimers()
  })

  it('clears session data', () => {
    feedRawData('s1', '\x1b]0;Title\x07')
    clearSession('s1')
    expect(getLastTitle('s1')).toBe('')
    expect(isTitleAnimating('s1')).toBe(false)
  })

  it('handles multiple titles in one chunk', () => {
    feedRawData('s1', '\x1b]0;First\x07text\x1b]0;Second\x07')
    expect(getLastTitle('s1')).toBe('Second')
  })
})
