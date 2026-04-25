import { describe, expect, it } from 'vitest'
import { chunkIndicatesCodexInterruptedPrompt } from './codex-terminal-state'

describe('chunkIndicatesCodexInterruptedPrompt', () => {
  it('recognizes Codex returning to the prompt after an interrupted conversation', () => {
    expect(chunkIndicatesCodexInterruptedPrompt(
      '■ Conversation interrupted - tell the model what to do differently. Something went wrong? Hit `/feedback` to report the issue.\r\n› Use /skills to list available skills',
    )).toBe(true)
  })

  it('ignores unrelated Codex terminal output', () => {
    expect(chunkIndicatesCodexInterruptedPrompt(
      'Thinking...\nRunning tests...\n',
    )).toBe(false)
  })
})
