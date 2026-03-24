import { describe, it, expect } from 'vitest'
import { stripAnsi, parseClaudeUsageOutput, parseCodexStatusOutput } from './usage-probe'

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

describe('stripAnsi', () => {
  it('strips CSI color codes', () => {
    expect(stripAnsi('\x1b[32mHello\x1b[0m world')).toBe('Hello world')
  })

  it('strips OSC title sequences', () => {
    expect(stripAnsi('\x1b]0;Title\x07text')).toBe('text')
  })

  it('strips carriage returns', () => {
    expect(stripAnsi('line1\rline2')).toBe('line1line2')
  })

  it('returns plain text unchanged', () => {
    expect(stripAnsi('plain text 100%')).toBe('plain text 100%')
  })
})

// ---------------------------------------------------------------------------
// parseClaudeUsageOutput — "remaining" percentages
// ---------------------------------------------------------------------------

describe('parseClaudeUsageOutput', () => {
  it('parses "remaining" percentages and converts to used', () => {
    const raw = [
      'Current session: 73.5% remaining',
      'Resets in 2 hours',
      'Current week: 40% remaining',
      'Resets Monday',
    ].join('\n')

    const result = parseClaudeUsageOutput(raw)
    expect(result.error).toBeNull()
    expect(result.session).toEqual({ usedPercent: 26.5, resetsAt: 'in 2 hours' })
    expect(result.weekly).toEqual({ usedPercent: 60, resetsAt: 'Monday' })
  })

  it('parses "used" percentages directly', () => {
    const raw = [
      'Session usage: 55% used',
      'Resets in 1 hour',
      'Weekly usage: 82% used',
      'Resets on Monday at 00:00 UTC',
    ].join('\n')

    const result = parseClaudeUsageOutput(raw)
    expect(result.error).toBeNull()
    expect(result.session).toEqual({ usedPercent: 55, resetsAt: 'in 1 hour' })
    expect(result.weekly).toEqual({ usedPercent: 82, resetsAt: 'on Monday at 00:00 UTC' })
  })

  it('handles ANSI codes in the output', () => {
    const raw = '\x1b[1mCurrent session: \x1b[33m30% used\x1b[0m\nResets in 3h'
    const result = parseClaudeUsageOutput(raw)
    expect(result.session).toEqual({ usedPercent: 30, resetsAt: 'in 3h' })
  })

  it('returns null weekly when only session is present', () => {
    const raw = 'Session limit: 10% used'
    const result = parseClaudeUsageOutput(raw)
    expect(result.error).toBeNull()
    expect(result.session).toEqual({ usedPercent: 10, resetsAt: null })
    expect(result.weekly).toBeNull()
  })

  it('falls back to positional extraction when no labels found', () => {
    const raw = [
      'Limit: 25% used',
      'Other limit: 60% consumed',
    ].join('\n')

    const result = parseClaudeUsageOutput(raw)
    expect(result.error).toBeNull()
    expect(result.session!.usedPercent).toBe(25)
    expect(result.weekly!.usedPercent).toBe(60)
  })

  it('returns error for unparseable output', () => {
    const raw = 'Something completely unexpected\nNo percentages here'
    const result = parseClaudeUsageOutput(raw)
    expect(result.error).toBe('Could not parse usage output')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('returns nulls for empty output', () => {
    const result = parseClaudeUsageOutput('')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseCodexStatusOutput
// ---------------------------------------------------------------------------

describe('parseCodexStatusOutput', () => {
  it('parses 5h and weekly limits', () => {
    const raw = [
      '5h window: 45% used',
      'Resets in 2h 30m',
      'Weekly limit: 70% used',
      'Resets Monday at 00:00 UTC',
    ].join('\n')

    const result = parseCodexStatusOutput(raw)
    expect(result.error).toBeNull()
    expect(result.session).toEqual({ usedPercent: 45, resetsAt: 'in 2h 30m' })
    expect(result.weekly).toEqual({ usedPercent: 70, resetsAt: 'Monday at 00:00 UTC' })
  })

  it('parses "remaining" style output for codex', () => {
    const raw = [
      '5-hour limit: 80% remaining',
      'Weekly: 50% remaining',
    ].join('\n')

    const result = parseCodexStatusOutput(raw)
    expect(result.error).toBeNull()
    expect(result.session!.usedPercent).toBe(20)
    expect(result.weekly!.usedPercent).toBe(50)
  })

  it('returns error for unparseable output', () => {
    const raw = 'No useful info here'
    const result = parseCodexStatusOutput(raw)
    expect(result.error).toBe('Could not parse status output')
  })

  it('returns nulls for empty output', () => {
    const result = parseCodexStatusOutput('')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.error).toBeNull()
  })

  it('handles session-only output', () => {
    const raw = '5hr limit: 33% used'
    const result = parseCodexStatusOutput(raw)
    expect(result.session).toEqual({ usedPercent: 33, resetsAt: null })
    expect(result.weekly).toBeNull()
  })
})
