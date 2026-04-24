// src/main/usage-scanner.test.ts
import { describe, it, expect } from 'vitest'
import {
  extractClaudeTokenUsage,
  extractCodexTokenUsage,
  estimateCostUSD,
  aggregateDailyTokens,
} from './usage-scanner'

// ─── extractClaudeTokenUsage ────────────────────────────────────────────────

describe('extractClaudeTokenUsage', () => {
  it('extracts token counts from a valid assistant entry', () => {
    const entry = {
      type: 'assistant',
      timestamp: '2026-03-23T10:00:00Z',
      message: {
        model: 'claude-opus-4-6',
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
        },
      },
    }
    const result = extractClaudeTokenUsage(entry)
    expect(result).toEqual({
      model: 'claude-opus-4-6',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 300,
      cacheWriteTokens: 200,
      timestamp: '2026-03-23T10:00:00Z',
    })
  })

  it('returns null for non-assistant entries', () => {
    expect(extractClaudeTokenUsage({ type: 'user', timestamp: '2026-03-23T10:00:00Z' })).toBeNull()
    expect(extractClaudeTokenUsage({ type: 'system' })).toBeNull()
    expect(extractClaudeTokenUsage({ type: 'result' })).toBeNull()
  })

  it('returns null when message is missing', () => {
    expect(extractClaudeTokenUsage({ type: 'assistant' })).toBeNull()
  })

  it('returns null when usage is missing', () => {
    const entry = {
      type: 'assistant',
      timestamp: '2026-03-23T10:00:00Z',
      message: { model: 'claude-sonnet-4-20250514' },
    }
    expect(extractClaudeTokenUsage(entry)).toBeNull()
  })

  it('returns null when model is missing', () => {
    const entry = {
      type: 'assistant',
      timestamp: '2026-03-23T10:00:00Z',
      message: { usage: { input_tokens: 100, output_tokens: 50 } },
    }
    expect(extractClaudeTokenUsage(entry)).toBeNull()
  })

  it('defaults missing usage fields to 0', () => {
    const entry = {
      type: 'assistant',
      timestamp: '2026-03-23T10:00:00Z',
      message: {
        model: 'claude-haiku-3-5-20241022',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }
    const result = extractClaudeTokenUsage(entry)
    expect(result).toEqual({
      model: 'claude-haiku-3-5-20241022',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      timestamp: '2026-03-23T10:00:00Z',
    })
  })

  it('returns null for null / undefined input', () => {
    expect(extractClaudeTokenUsage(null)).toBeNull()
    expect(extractClaudeTokenUsage(undefined)).toBeNull()
  })
})

// ─── extractCodexTokenUsage ─────────────────────────────────────────────────

describe('extractCodexTokenUsage', () => {
  it('extracts token counts from a valid event_msg entry', () => {
    const entry = {
      type: 'event_msg',
      timestamp: '2026-03-23T12:00:00Z',
      payload: {
        info: {
          model: 'codex-mini-latest',
          total_token_usage: {
            input_tokens: 800,
            output_tokens: 200,
            cached_input_tokens: 100,
            reasoning_output_tokens: 50,
          },
        },
      },
    }
    const result = extractCodexTokenUsage(entry)
    expect(result).toEqual({
      model: 'codex-mini-latest',
      inputTokens: 800,
      outputTokens: 200,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      timestamp: '2026-03-23T12:00:00Z',
    })
  })

  it('returns null for non-event_msg entries', () => {
    expect(extractCodexTokenUsage({ type: 'user' })).toBeNull()
    expect(extractCodexTokenUsage({ type: 'assistant' })).toBeNull()
  })

  it('returns null when payload.info.total_token_usage is missing', () => {
    expect(extractCodexTokenUsage({ type: 'event_msg', payload: {} })).toBeNull()
    expect(extractCodexTokenUsage({ type: 'event_msg', payload: { info: {} } })).toBeNull()
  })

  it('defaults model to "codex" when model is missing', () => {
    const entry = {
      type: 'event_msg',
      timestamp: '2026-03-23T12:00:00Z',
      payload: {
        info: {
          total_token_usage: {
            input_tokens: 400,
            output_tokens: 100,
          },
        },
      },
    }
    const result = extractCodexTokenUsage(entry)
    expect(result!.model).toBe('codex')
  })
})

// ─── estimateCostUSD ────────────────────────────────────────────────────────

describe('estimateCostUSD', () => {
  it('calculates cost for Opus model', () => {
    // 1M input @ $15 + 1M output @ $75 = $90
    const cost = estimateCostUSD('claude-opus-4-6', 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(90, 2)
  })

  it('calculates cost for Sonnet model', () => {
    // 1M input @ $3 + 1M output @ $15 = $18
    const cost = estimateCostUSD('claude-sonnet-4-20250514', 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(18, 2)
  })

  it('calculates cost for Haiku model', () => {
    // 1M input @ $0.8 + 1M output @ $4 = $4.8
    const cost = estimateCostUSD('claude-haiku-3-5-20241022', 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(4.8, 2)
  })

  it('defaults to Sonnet pricing for unknown models', () => {
    const cost = estimateCostUSD('some-unknown-model', 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(18, 2)
  })

  it('includes cache read and cache write tokens in cost', () => {
    // Opus: 1M cacheRead @ $1.5 + 1M cacheWrite @ $18.75 = $20.25
    const cost = estimateCostUSD('claude-opus-4-6', 0, 0, 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(20.25, 2)
  })

  it('returns 0 for zero tokens', () => {
    expect(estimateCostUSD('claude-opus-4-6', 0, 0, 0, 0)).toBe(0)
  })

  it('handles small token counts correctly', () => {
    // 1000 input tokens on Opus: (1000/1M) * 15 = 0.015
    const cost = estimateCostUSD('claude-opus-4-6', 1000, 0)
    expect(cost).toBeCloseTo(0.015, 6)
  })
})

// ─── aggregateDailyTokens ───────────────────────────────────────────────────

describe('aggregateDailyTokens', () => {
  // Timestamps are kept away from 00:00Z so grouping is stable across CI
  // timezones (we bucket by local date, not UTC date).
  it('groups token entries by date', () => {
    const entries = [
      { model: 'opus', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, timestamp: '2026-03-22T14:00:00Z' },
      { model: 'opus', inputTokens: 200, outputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 10, timestamp: '2026-03-22T16:00:00Z' },
      { model: 'sonnet', inputTokens: 300, outputTokens: 150, cacheReadTokens: 30, cacheWriteTokens: 15, timestamp: '2026-03-23T14:00:00Z' },
    ]
    const result = aggregateDailyTokens(entries)
    expect(result).toEqual([
      { date: '2026-03-22', inputTokens: 300, outputTokens: 150, cacheReadTokens: 30, cacheWriteTokens: 15 },
      { date: '2026-03-23', inputTokens: 300, outputTokens: 150, cacheReadTokens: 30, cacheWriteTokens: 15 },
    ])
  })

  it('returns sorted results by date', () => {
    const entries = [
      { model: 'opus', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, timestamp: '2026-03-25T14:00:00Z' },
      { model: 'opus', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, timestamp: '2026-03-20T14:00:00Z' },
      { model: 'opus', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, timestamp: '2026-03-23T14:00:00Z' },
    ]
    const result = aggregateDailyTokens(entries)
    expect(result.map((d) => d.date)).toEqual(['2026-03-20', '2026-03-23', '2026-03-25'])
  })

  it('returns empty array for empty input', () => {
    expect(aggregateDailyTokens([])).toEqual([])
  })

  it('skips entries with empty timestamp', () => {
    const entries = [
      { model: 'opus', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, timestamp: '' },
    ]
    expect(aggregateDailyTokens(entries)).toEqual([])
  })
})
