import { describe, expect, it } from 'vitest'
import { parseTicketDraft, buildTicketPrompt } from './ticket-draft-parse'

describe('parseTicketDraft', () => {
  it('parses a clean JSON object', () => {
    const draft = parseTicketDraft('{"title":"Add Linear icon","description":"body","labelNames":["ui"],"projectName":"Web","priority":3}')
    expect(draft).toEqual({
      title: 'Add Linear icon',
      description: 'body',
      labelNames: ['ui'],
      projectName: 'Web',
      priority: 3,
    })
  })

  it('extracts JSON embedded in surrounding prose / code fences', () => {
    const text = 'Here is the ticket:\n```json\n{"title":"Fix bug","description":"d","labelNames":[],"projectName":null,"priority":0}\n```\nDone.'
    expect(parseTicketDraft(text)?.title).toBe('Fix bug')
  })

  it('coerces missing/invalid fields to safe defaults', () => {
    const draft = parseTicketDraft('{"title":"  Only a title  ","labelNames":["a",2,"b"],"priority":"high"}')
    expect(draft).toEqual({
      title: 'Only a title',
      description: '',
      labelNames: ['a', 'b'],
      projectName: null,
      priority: 0,
    })
  })

  it('returns null without a title', () => {
    expect(parseTicketDraft('{"description":"no title"}')).toBeNull()
    expect(parseTicketDraft('{"title":"   "}')).toBeNull()
  })

  it('returns null when there is no JSON object', () => {
    expect(parseTicketDraft('the agent said nothing useful')).toBeNull()
    expect(parseTicketDraft('')).toBeNull()
  })
})

describe('buildTicketPrompt', () => {
  it('lists the allowed labels and projects', () => {
    const p = buildTicketPrompt(['ui', 'bug'], ['Web'])
    expect(p).toContain('ui, bug')
    expect(p).toContain('Web')
  })

  it('shows (none) when a list is empty', () => {
    const p = buildTicketPrompt([], [])
    expect(p).toContain('(none)')
  })
})
