// src/main/claude-activity-parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseJsonlLines, isSessionWorking, cleanForDisplay } from './claude-activity-parser'

// ─── isSessionWorking ───────────────────────────────────────────────────────

describe('isSessionWorking', () => {
  it('returns false when processStatus is "terminal"', () => {
    expect(isSessionWorking('terminal', undefined)).toBe(false)
    expect(isSessionWorking('terminal', 'idle')).toBe(false)
    expect(isSessionWorking('terminal', 'thinking')).toBe(false)
  })

  it('returns false when processStatus is "codex"', () => {
    expect(isSessionWorking('codex', undefined)).toBe(false)
    expect(isSessionWorking('codex', 'idle')).toBe(false)
  })

  describe('processStatus is "claude"', () => {
    it('returns false when claudeActivity is undefined (no JSONL data yet)', () => {
      // THIS IS THE CRITICAL BUG FIX TEST
      // undefined means we haven't received any JSONL activity data yet
      // We must NOT treat "no data" as "working"
      expect(isSessionWorking('claude', undefined)).toBe(false)
    })

    it('returns false when claudeActivity is "idle"', () => {
      expect(isSessionWorking('claude', 'idle')).toBe(false)
    })

    it('returns true when claudeActivity is "thinking"', () => {
      expect(isSessionWorking('claude', 'thinking')).toBe(true)
    })

    it('returns true when claudeActivity is "tool_executing"', () => {
      expect(isSessionWorking('claude', 'tool_executing')).toBe(true)
    })
  })
})

// ─── parseJsonlLines ────────────────────────────────────────────────────────

describe('parseJsonlLines', () => {
  it('returns idle for empty input', () => {
    const result = parseJsonlLines([])
    expect(result.activity).toBe('idle')
    expect(result.lastResponse).toBe('')
  })

  it('returns idle for unparseable lines', () => {
    const result = parseJsonlLines(['not json', '{bad'])
    expect(result.activity).toBe('idle')
  })

  it('detects idle when last entry is assistant with end_turn', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Done!' }]
        }
      })
    ]
    const result = parseJsonlLines(lines)
    expect(result.activity).toBe('idle')
    expect(result.lastResponse).toBe('Done!')
  })

  it('detects thinking when last entry is a user message', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'prev' }] }
      }),
      JSON.stringify({
        type: 'user',
        message: { content: 'Fix the bug' }
      })
    ]
    const result = parseJsonlLines(lines)
    expect(result.activity).toBe('thinking')
    // lastResponse should still come from the assistant message
    expect(result.lastResponse).toBe('prev')
  })

  it('detects tool_executing when assistant has tool_use stop_reason', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'Let me read that file.' },
            { type: 'tool_use', id: 'xyz', name: 'Read', input: {} }
          ]
        }
      })
    ]
    const result = parseJsonlLines(lines)
    expect(result.activity).toBe('tool_executing')
    expect(result.lastResponse).toBe('Let me read that file.')
  })

  it('detects tool_executing when content contains tool_use blocks (no stop_reason)', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Reading...' },
            { type: 'tool_use', id: 'abc', name: 'Bash', input: {} }
          ]
        }
      })
    ]
    const result = parseJsonlLines(lines)
    expect(result.activity).toBe('tool_executing')
  })

  it('detects thinking when assistant message has no stop_reason and no tool_use', () => {
    // This represents a streaming response in progress
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'I am thinking about...' }]
        }
      })
    ]
    const result = parseJsonlLines(lines)
    expect(result.activity).toBe('thinking')
  })

  it('detects tool_executing for subagent progress entries (e.g. Explore)', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'old' }] }
      }),
      JSON.stringify({
        type: 'progress',
        data: { tool_name: 'Agent', subagent_type: 'Explore' }
      })
    ]
    const result = parseJsonlLines(lines)
    expect(result.activity).toBe('tool_executing')
  })

  it('skips hook_progress entries and reads through to the real state', () => {
    // This is the REAL format Claude Code writes after end_turn:
    // 1. assistant (end_turn)
    // 2. progress (hook_progress for Stop hook)
    // 3. system (stop_hook_summary)
    // The parser must skip #3 and #2 to find #1 → idle
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done!' }] }
      }),
      JSON.stringify({
        type: 'progress',
        data: { type: 'hook_progress', hookEvent: 'Stop', hookName: 'Stop', command: 'node check.js' }
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'stop_hook_summary',
        hookCount: 1,
        hookErrors: []
      })
    ]
    const result = parseJsonlLines(lines)
    expect(result.activity).toBe('idle')
    expect(result.lastResponse).toBe('Done!')
  })

  it('skips system entries to find the real activity state', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { content: 'Do something' }
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'some_system_event'
      })
    ]
    const result = parseJsonlLines(lines)
    expect(result.activity).toBe('thinking')
  })

  it('detects idle for result entries (end of conversation turn)', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { content: 'Do something' }
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Done' }]
        }
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        cost_usd: 0.05
      })
    ]
    const result = parseJsonlLines(lines)
    expect(result.activity).toBe('idle')
  })

  it('handles mixed valid and invalid lines', () => {
    const lines = [
      'garbage',
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] }
      }),
      'more garbage',
      JSON.stringify({
        type: 'user',
        message: { content: 'Do it' }
      })
    ]
    const result = parseJsonlLines(lines)
    // Last valid line is the user message → thinking
    expect(result.activity).toBe('thinking')
  })

  it('gets lastResponse from most recent assistant with text', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'First response' }] }
      }),
      JSON.stringify({
        type: 'user',
        message: { content: 'Another question' }
      }),
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Second response' }] }
      })
    ]
    const result = parseJsonlLines(lines)
    // Most recent assistant is the last one
    expect(result.lastResponse).toBe('Second response')
  })

  it('skips assistant messages with empty text', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Real response' }] }
      }),
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] }
      })
    ]
    const result = parseJsonlLines(lines)
    // Second assistant has no text, so response comes from first
    expect(result.lastResponse).toBe('Real response')
  })

  it('handles user message with array content', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'Fix this bug' }] }
      })
    ]
    const result = parseJsonlLines(lines)
    expect(result.activity).toBe('thinking')
  })

  it('treats interrupt marker user messages as idle', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: null, content: [{ type: 'text', text: 'Working on it...' }] }
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] }
      })
    ]
    const result = parseJsonlLines(lines)
    expect(result.activity).toBe('idle')
    expect(result.lastResponse).toBe('Working on it...')
  })

  it('detects idle when last-prompt follows assistant with null stop_reason', () => {
    // REAL BUG: Claude Code sometimes writes the final assistant message with
    // stop_reason: null (not end_turn). The last-prompt entry that follows
    // definitively signals Claude is idle and waiting for input.
    const lines = [
      JSON.stringify({
        type: 'progress',
        data: { type: 'hook_progress' }
      }),
      JSON.stringify({
        type: 'progress',
        data: { type: 'hook_progress' }
      }),
      JSON.stringify({
        type: 'file-history-snapshot',
        data: {}
      }),
      JSON.stringify({
        type: 'user',
        message: { content: 'tell me a joke' }
      }),
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: null, content: [] }
      }),
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: null, content: [{ type: 'text', text: 'Why do programmers prefer dark mode?\n\nBecause light attracts bugs.' }] }
      }),
      JSON.stringify({
        type: 'progress',
        data: { type: 'hook_progress' }
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'stop_hook_summary'
      }),
      JSON.stringify({
        type: 'last-prompt',
        data: { prompt: 'tell me a joke' }
      })
    ]
    const result = parseJsonlLines(lines)
    expect(result.activity).toBe('idle')
    expect(result.lastResponse).toBe('Why do programmers prefer dark mode?\n\nBecause light attracts bugs.')
  })

  it('detects idle for standalone last-prompt entry', () => {
    const lines = [
      JSON.stringify({
        type: 'last-prompt',
        data: { prompt: 'hello' }
      })
    ]
    const result = parseJsonlLines(lines)
    expect(result.activity).toBe('idle')
  })

  it('last-prompt overrides preceding assistant with null stop_reason', () => {
    // Without last-prompt fix, the parser would see the assistant with
    // stop_reason=null and return 'thinking'
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: null, content: [{ type: 'text', text: 'response' }] }
      }),
      JSON.stringify({
        type: 'last-prompt',
        data: {}
      })
    ]
    const result = parseJsonlLines(lines)
    expect(result.activity).toBe('idle')
  })
})

// ─── cleanForDisplay ────────────────────────────────────────────────────────

describe('cleanForDisplay', () => {
  it('removes code blocks', () => {
    expect(cleanForDisplay('Before ```const x = 1``` After')).toBe('Before [code] After')
  })

  it('strips inline code backticks', () => {
    expect(cleanForDisplay('Use `npm install`')).toBe('Use npm install')
  })

  it('strips bold markdown', () => {
    expect(cleanForDisplay('This is **bold**')).toBe('This is bold')
  })

  it('strips italic markdown', () => {
    expect(cleanForDisplay('This is *italic*')).toBe('This is italic')
  })

  it('strips heading markers', () => {
    expect(cleanForDisplay('## Title')).toBe('Title')
  })

  it('strips list markers', () => {
    expect(cleanForDisplay('- item 1\n* item 2')).toBe('item 1 item 2')
  })

  it('collapses newlines to spaces', () => {
    expect(cleanForDisplay('line1\n\nline2')).toBe('line1 line2')
  })

  it('truncates to 200 chars', () => {
    const long = 'a'.repeat(300)
    expect(cleanForDisplay(long).length).toBe(200)
  })
})
