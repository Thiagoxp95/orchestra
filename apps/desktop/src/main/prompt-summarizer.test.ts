import { describe, expect, it } from 'vitest'
import { normalizePromptText, shouldSummarizePrompt } from './prompt-summarizer'

describe('normalizePromptText', () => {
  it('collapses whitespace for prompt display and summary decisions', () => {
    expect(normalizePromptText('  Fix   the\n\nsidebar   spacing  ')).toBe('Fix the sidebar spacing')
  })
})

describe('shouldSummarizePrompt', () => {
  it('keeps short prompts verbatim', () => {
    expect(shouldSummarizePrompt('Fix build')).toBe(false)
    expect(shouldSummarizePrompt('Refactor auth flow')).toBe(false)
  })

  it('summarizes prompts once they exceed the short-request threshold', () => {
    expect(shouldSummarizePrompt('Refactor the authentication flow for the desktop app')).toBe(true)
    expect(shouldSummarizePrompt('one two three four five')).toBe(true)
  })
})
