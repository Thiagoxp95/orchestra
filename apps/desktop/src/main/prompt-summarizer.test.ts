import { describe, expect, it } from 'vitest'
import {
  detectRequiresUserInput,
  normalizePromptText,
  shouldSummarizePrompt,
} from './prompt-summarizer'

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

describe('detectRequiresUserInput', () => {
  it('returns false for an empty or whitespace response', () => {
    expect(detectRequiresUserInput('')).toBe(false)
    expect(detectRequiresUserInput('   ')).toBe(false)
  })

  it('does NOT flag a joke whose setup contains a rhetorical "?"', () => {
    expect(
      detectRequiresUserInput(
        'Why do programmers prefer dark mode? Because light attracts bugs.',
      ),
    ).toBe(false)
  })

  it('does NOT flag a rhetorical question mid-explanation', () => {
    expect(
      detectRequiresUserInput(
        'The function returns null on failure. Why? Because throwing would break callers.',
      ),
    ).toBe(false)
  })

  it('does NOT flag a tail question that does not address the user', () => {
    // "Does this work?" without "you" → likely rhetorical / self-check
    expect(detectRequiresUserInput('Running the tests. Does this work?')).toBe(false)
  })

  it('flags a direct question addressed to the user at the tail', () => {
    expect(
      detectRequiresUserInput(
        'I implemented the refactor. Would you like me to also update the tests?',
      ),
    ).toBe(true)
  })

  it('flags a "let me know" invitation at the tail', () => {
    expect(
      detectRequiresUserInput('Applied the patch. Let me know if anything looks off.'),
    ).toBe(true)
  })

  it('flags "shall I" / "should I" invitations', () => {
    expect(detectRequiresUserInput('Shall I proceed with the deletion?')).toBe(true)
    expect(detectRequiresUserInput('Should I run the migration now?')).toBe(true)
  })

  it('flags explicit "please confirm" / "please choose"', () => {
    expect(
      detectRequiresUserInput('Found two matching files. Please choose which one to edit.'),
    ).toBe(true)
  })

  it('does NOT flag a question followed by Claude answering itself', () => {
    expect(
      detectRequiresUserInput(
        'Does this match the spec? Yes — the test suite passes and coverage is unchanged.',
      ),
    ).toBe(false)
  })
})
