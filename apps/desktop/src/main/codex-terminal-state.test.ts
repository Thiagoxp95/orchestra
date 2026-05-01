import { describe, expect, it } from 'vitest'
import { chunkIndicatesCodexInterruptedPrompt, chunkIndicatesCodexPromptReady } from './codex-terminal-state'

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

describe('chunkIndicatesCodexPromptReady', () => {
  it('recognizes Codex returning to the editable prompt with its status footer', () => {
    expect(chunkIndicatesCodexPromptReady(
      '• What’s something you used to enjoy but haven’t done in a while?\x07\n› Improve documentation in @filename\n  gpt-5.5 low · ~/Tedy/orchestra',
    )).toBe(true)
  })

  it('ignores submitted prompt transcript lines without the Codex footer', () => {
    expect(chunkIndicatesCodexPromptReady(
      '› ask me something\n• What’s one thing you want to get done today?',
    )).toBe(false)
  })
})
