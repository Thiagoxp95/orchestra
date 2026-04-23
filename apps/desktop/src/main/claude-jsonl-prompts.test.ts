// apps/desktop/src/main/claude-jsonl-prompts.test.ts
import { describe, it, expect } from 'vitest'
import { extractLastUserPrompt } from './claude-jsonl-prompts'

describe('extractLastUserPrompt', () => {
  it('returns the last plain user text', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'user', message: { content: 'second prompt' } }),
    ]
    expect(extractLastUserPrompt(lines)).toBe('second prompt')
  })

  it('skips tool_result entries', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'real prompt' } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] } }),
    ]
    expect(extractLastUserPrompt(lines)).toBe('real prompt')
  })

  it('strips <system-reminder>...</system-reminder> blocks', () => {
    const content = '<system-reminder>be careful</system-reminder>\n\nactual user text'
    const lines = [JSON.stringify({ type: 'user', message: { content } })]
    expect(extractLastUserPrompt(lines)).toBe('actual user text')
  })

  it('returns null when only system-reminder content present', () => {
    const content = '<system-reminder>only this</system-reminder>'
    const lines = [JSON.stringify({ type: 'user', message: { content } })]
    expect(extractLastUserPrompt(lines)).toBeNull()
  })

  it('handles array content with text blocks', () => {
    const content = [{ type: 'text', text: 'block prompt' }]
    const lines = [JSON.stringify({ type: 'user', message: { content } })]
    expect(extractLastUserPrompt(lines)).toBe('block prompt')
  })

  it('returns null on empty input', () => {
    expect(extractLastUserPrompt([])).toBeNull()
  })

  it('ignores malformed JSON lines', () => {
    const lines = ['not json', JSON.stringify({ type: 'user', message: { content: 'good' } })]
    expect(extractLastUserPrompt(lines)).toBe('good')
  })
})
