import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyAgentResponseWithOpenRouter,
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

describe('classifyAgentResponseWithOpenRouter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the model classification for agent responses that expect input', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              title: 'Choose a path',
              summary: 'The agent is asking which implementation path to take.',
              requiresUserInput: true,
            }),
          },
        }],
      })),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await classifyAgentResponseWithOpenRouter(
      'I can implement this two ways. Which option do you prefer?',
      { apiKey: 'sk-or-v1-test', model: 'openai/gpt-4.1-mini' },
    )

    expect(result).toEqual({
      title: 'Choose a path',
      summary: 'The agent is asking which implementation path to take.',
      requiresUserInput: true,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-or-v1-test',
        }),
      }),
    )
  })
})
