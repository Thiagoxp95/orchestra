import { describe, expect, it } from 'vitest'
import {
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  CLAUDE_LONG_CONTEXT_WINDOW,
  claudeContextWindow,
  claudeProjectDir,
  parseClaudeContextTail,
  parseCodexContextTail,
  pickClaudeTranscript,
  transcriptGuessFloor,
} from './agent-context'

const claudeLine = (usage: Record<string, unknown>, model = 'claude-opus-5', effort?: string): string =>
  JSON.stringify({ type: 'assistant', ...(effort ? { effort } : {}), message: { model, usage } })

const codexLine = (info: Record<string, unknown>): string =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info } })

const codexTurnContext = (payload: Record<string, unknown>): string =>
  JSON.stringify({ type: 'turn_context', payload })

describe('parseClaudeContextTail', () => {
  it('sums fresh input, both cache halves and the output', () => {
    const tail = claudeLine({
      input_tokens: 2,
      cache_creation_input_tokens: 2581,
      cache_read_input_tokens: 96300,
      output_tokens: 1389,
    })
    expect(parseClaudeContextTail(tail, false)).toEqual({
      usedTokens: 100272,
      contextWindow: CLAUDE_DEFAULT_CONTEXT_WINDOW,
      model: 'claude-opus-5',
    })
  })

  it('carries the model and effort the record stamps', () => {
    const tail = [
      claudeLine({ input_tokens: 100, output_tokens: 1 }, 'claude-opus-5', 'high'),
      claudeLine({ input_tokens: 200, output_tokens: 1 }, 'claude-fable-5', 'xhigh'),
    ].join('\n')
    const parsed = parseClaudeContextTail(tail, false)
    expect(parsed?.model).toBe('claude-fable-5')
    expect(parsed?.effort).toBe('xhigh')
  })

  it('leaves effort absent when the record has none', () => {
    const parsed = parseClaudeContextTail(claudeLine({ input_tokens: 5, output_tokens: 5 }), false)
    expect(parsed?.effort).toBeUndefined()
  })

  it('reads the newest turn, not the first', () => {
    const tail = [
      claudeLine({ input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 5 }),
      claudeLine({ input_tokens: 10, cache_read_input_tokens: 50_000, output_tokens: 5 }),
    ].join('\n')
    expect(parseClaudeContextTail(tail, false)?.usedTokens).toBe(50_015)
  })

  it('drops the leading fragment of a mid-line tail read', () => {
    const complete = claudeLine({ input_tokens: 1, cache_read_input_tokens: 900, output_tokens: 9 })
    // A truncated first line would parse as nothing anyway; the point is that a
    // fragment which *happens* to parse can't be mistaken for a record.
    const tail = `${claudeLine({ input_tokens: 999_999 })}\n${complete}`
    expect(parseClaudeContextTail(tail, true)?.usedTokens).toBe(910)
  })

  it('skips records without usage, and returns null when the tail has none', () => {
    const tail = [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      'not json at all',
      claudeLine({ input_tokens: 4, cache_read_input_tokens: 96, output_tokens: 0 }),
    ].join('\n')
    expect(parseClaudeContextTail(tail, false)?.usedTokens).toBe(100)
    expect(parseClaudeContextTail('{"type":"user"}\n', false)).toBeNull()
    expect(parseClaudeContextTail('', false)).toBeNull()
  })

  it('ignores a usage record whose fields are all zero', () => {
    expect(parseClaudeContextTail(claudeLine({ input_tokens: 0, output_tokens: 0 }), false)).toBeNull()
  })
})

describe('claudeContextWindow', () => {
  it('defaults to the 200k window', () => {
    expect(claudeContextWindow('claude-opus-5', 50_000)).toBe(CLAUDE_DEFAULT_CONTEXT_WINDOW)
    expect(claudeContextWindow(null, 50_000)).toBe(CLAUDE_DEFAULT_CONTEXT_WINDOW)
  })

  it('takes the long window from a model id that declares it', () => {
    expect(claudeContextWindow('claude-opus-5[1m]', 10)).toBe(CLAUDE_LONG_CONTEXT_WINDOW)
    expect(claudeContextWindow('claude-sonnet-5-1m', 10)).toBe(CLAUDE_LONG_CONTEXT_WINDOW)
  })

  it('infers the long window from usage that could not have fit in the short one', () => {
    // The 1M variants record the plain base model id, so this is the only signal
    // a long-context session gives us until it overflows 200k.
    expect(claudeContextWindow('claude-opus-5', 240_000)).toBe(CLAUDE_LONG_CONTEXT_WINDOW)
  })
})

describe('parseCodexContextTail', () => {
  it('reads the last turn against the window codex reports', () => {
    const tail = codexLine({
      total_token_usage: { total_tokens: 12_095_930 },
      last_token_usage: { input_tokens: 39_333, output_tokens: 45, total_tokens: 39_378 },
      model_context_window: 258_400,
    })
    expect(parseCodexContextTail(tail, false)).toEqual({
      usedTokens: 39_378,
      contextWindow: 258_400,
    })
  })

  it('never reports the cumulative total, which runs past the window', () => {
    const tail = codexLine({
      total_token_usage: { total_tokens: 12_095_930 },
      last_token_usage: { total_tokens: 1_000 },
      model_context_window: 258_400,
    })
    expect(parseCodexContextTail(tail, false)?.usedTokens).toBe(1_000)
  })

  it('reads the newest token_count and ignores other events', () => {
    const tail = [
      codexLine({ last_token_usage: { total_tokens: 100 }, model_context_window: 258_400 }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
      codexLine({ last_token_usage: { total_tokens: 900 }, model_context_window: 258_400 }),
    ].join('\n')
    expect(parseCodexContextTail(tail, false)?.usedTokens).toBe(900)
  })

  it('returns null without a window or a usage', () => {
    expect(parseCodexContextTail(codexLine({ last_token_usage: { total_tokens: 5 } }), false)).toBeNull()
    expect(parseCodexContextTail(codexLine({ model_context_window: 258_400 }), false)).toBeNull()
    expect(parseCodexContextTail('{"type":"response_item"}', false)).toBeNull()
  })

  it('pairs the usage with the newest turn_context model and effort', () => {
    const tail = [
      codexTurnContext({ model: 'gpt-5.5', effort: 'medium' }),
      codexTurnContext({ model: 'gpt-5.6-sol', effort: 'high' }),
      codexLine({ last_token_usage: { total_tokens: 900 }, model_context_window: 258_400 }),
    ].join('\n')
    expect(parseCodexContextTail(tail, false)).toEqual({
      usedTokens: 900,
      contextWindow: 258_400,
      model: 'gpt-5.6-sol',
      effort: 'high',
    })
  })

  it('still answers occupancy when the tail holds no turn_context', () => {
    const tail = codexLine({ last_token_usage: { total_tokens: 900 }, model_context_window: 258_400 })
    const parsed = parseCodexContextTail(tail, false)
    expect(parsed?.usedTokens).toBe(900)
    expect(parsed?.model).toBeUndefined()
  })

  it('a turn_context alone is not an occupancy answer', () => {
    expect(parseCodexContextTail(codexTurnContext({ model: 'gpt-5.6-sol' }), false)).toBeNull()
  })
})

describe('claudeProjectDir', () => {
  it('collapses every non-alphanumeric run in the cwd to one dash', () => {
    expect(claudeProjectDir('/Users/x/Tedy/orchestra', '/home')).toBe(
      '/home/.claude/projects/-Users-x-Tedy-orchestra',
    )
    expect(claudeProjectDir('/Users/x/.orchestra-worktrees/eng_1', '/home')).toBe(
      '/home/.claude/projects/-Users-x-orchestra-worktrees-eng-1',
    )
  })
})

describe('pickClaudeTranscript', () => {
  const entries = [
    { name: 'old.jsonl', mtimeMs: 100 },
    { name: 'new.jsonl', mtimeMs: 300 },
    { name: 'notes.txt', mtimeMs: 900 },
  ]

  it('takes the most recently written transcript', () => {
    expect(pickClaudeTranscript(entries, new Set())).toBe('new.jsonl')
  })

  it('leaves a transcript another session already holds', () => {
    expect(pickClaudeTranscript(entries, new Set(['new.jsonl']))).toBe('old.jsonl')
  })

  it('returns null when every candidate is claimed', () => {
    expect(pickClaudeTranscript(entries, new Set(['new.jsonl', 'old.jsonl']))).toBeNull()
    expect(pickClaudeTranscript([], new Set())).toBeNull()
  })

  // The foreign-chat bug: a session launched at t=1000 must not adopt a
  // conversation created before it existed, however recently it was written.
  it('skips conversations created before the floor', () => {
    const aged = [
      { name: 'foreign.jsonl', mtimeMs: 900, createdMs: 100 },
      { name: 'mine.jsonl', mtimeMs: 500, createdMs: 400 },
    ]
    expect(pickClaudeTranscript(aged, new Set(), 300)).toBe('mine.jsonl')
    expect(pickClaudeTranscript(aged, new Set(), 600)).toBeNull()
    expect(pickClaudeTranscript(aged, new Set())).toBe('foreign.jsonl')
  })

  it('floors on mtime when the platform records no birth time', () => {
    expect(pickClaudeTranscript(entries, new Set(), 200)).toBe('new.jsonl')
    expect(pickClaudeTranscript(entries, new Set(), 400)).toBeNull()
  })
})

describe('transcriptGuessFloor', () => {
  it('leaves re-adopted sessions unfloored', () => {
    // Every running agent is re-tracked within seconds of the process starting;
    // their conversations rightly predate that, and for a hook-silent install
    // the guess is the only pairing they will ever get.
    expect(transcriptGuessFloor(1_000, 1_000)).toBeUndefined()
    expect(transcriptGuessFloor(1_000, 15_000)).toBeUndefined()
  })

  it('floors a session that launched after the process settled', () => {
    const floor = transcriptGuessFloor(1_000, 600_000)
    expect(floor).toBeDefined()
    expect(floor).toBeLessThan(600_000)
    // Generous enough that a title flip trailing claude's first write is safe.
    expect(600_000 - (floor as number)).toBeGreaterThanOrEqual(10_000)
  })
})
