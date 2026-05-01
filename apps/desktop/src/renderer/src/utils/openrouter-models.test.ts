import { describe, expect, it } from 'vitest'
import { filterOpenRouterModels, normalizeOpenRouterModels } from './openrouter-models'

describe('filterOpenRouterModels', () => {
  const models = [
    { id: 'openai/gpt-4.1-mini', name: 'OpenAI: GPT-4.1 Mini' },
    { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5' },
    { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro' },
  ]

  it('returns every model before the user searches', () => {
    expect(filterOpenRouterModels(models, '')).toEqual(models)
  })

  it('filters by id or display name when searching', () => {
    expect(filterOpenRouterModels(models, 'claude')).toEqual([
      { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5' },
    ])
    expect(filterOpenRouterModels(models, 'Google')).toEqual([
      { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro' },
    ])
  })
})

describe('normalizeOpenRouterModels', () => {
  it('normalizes and sorts OpenRouter model payloads', () => {
    expect(normalizeOpenRouterModels({
      data: [
        { id: 'z/model', name: '' },
        { id: 'a/model', name: 'A Model' },
        { id: 123, name: 'Invalid' },
      ],
    })).toEqual([
      { id: 'a/model', name: 'A Model' },
      { id: 'z/model', name: 'z/model' },
    ])
  })
})
