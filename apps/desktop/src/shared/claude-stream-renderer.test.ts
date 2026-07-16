import { describe, expect, it } from 'vitest'
import { createClaudeStreamRenderer } from './claude-stream-renderer'

function collect(): { texts: string[]; onText: (t: string) => void; joined: () => string } {
  const texts: string[] = []
  return { texts, onText: (t) => texts.push(t), joined: () => texts.join('') }
}

function assistantEvent(blocks: unknown[]): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } })
}

describe('createClaudeStreamRenderer', () => {
  it('renders assistant text blocks', () => {
    const { onText, joined } = collect()
    const r = createClaudeStreamRenderer(onText)
    r.write(assistantEvent([{ type: 'text', text: 'Reviewing the diff now.' }]) + '\n')
    expect(joined()).toBe('Reviewing the diff now.\n')
  })

  it('renders tool_use blocks as one-liners with an input hint', () => {
    const { onText, joined } = collect()
    const r = createClaudeStreamRenderer(onText)
    r.write(assistantEvent([
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ]) + '\n')
    expect(joined()).toBe('⏺ Bash: npm test\n')
  })

  it('drops system, user, and thinking noise', () => {
    const { onText, joined } = collect()
    const r = createClaudeStreamRenderer(onText)
    r.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }) + '\n')
    r.write(JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 42 }) + '\n')
    r.write(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'done' }] } }) + '\n')
    r.write(assistantEvent([{ type: 'thinking', thinking: 'hmm' }]) + '\n')
    expect(joined()).toBe('')
  })

  it('drops the success result (duplicates the final assistant text)', () => {
    const { onText, joined } = collect()
    const r = createClaudeStreamRenderer(onText)
    r.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'finished' }) + '\n')
    expect(joined()).toBe('')
  })

  it('renders error results', () => {
    const { onText, joined } = collect()
    const r = createClaudeStreamRenderer(onText)
    r.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: Connection closed mid-response.' }) + '\n')
    expect(joined()).toBe('\n[error] API Error: Connection closed mid-response.\n')
  })

  it('passes non-JSON lines through verbatim (shell noise, command not found)', () => {
    const { onText, joined } = collect()
    const r = createClaudeStreamRenderer(onText)
    r.write('zsh: command not found: claude\n')
    expect(joined()).toBe('zsh: command not found: claude\n')
  })

  it('handles events split across chunks and CRLF line endings (PTY)', () => {
    const { onText, joined } = collect()
    const r = createClaudeStreamRenderer(onText)
    const line = assistantEvent([{ type: 'text', text: 'split across chunks' }]) + '\r\n'
    r.write(line.slice(0, 25))
    r.write(line.slice(25))
    expect(joined()).toBe('split across chunks\n')
  })

  it('flushes a trailing partial line on exit', () => {
    const { onText, joined } = collect()
    const r = createClaudeStreamRenderer(onText)
    r.write('no trailing newline')
    expect(joined()).toBe('')
    r.flush()
    expect(joined()).toBe('no trailing newline\n')
  })
})
