import { describe, expect, it } from 'vitest'
import { parseCodexRolloutLines } from './codex-rollout-parser'

describe('parseCodexRolloutLines', () => {
  it('marks working on task_started and idle on task_complete', () => {
    const result = parseCodexRolloutLines([
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Done' } }),
    ])

    expect(result).toEqual({ workState: 'idle', lastResponse: 'Done' })
  })

  it('keeps working when the latest event is task_started', () => {
    const result = parseCodexRolloutLines([
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Old' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    ])

    expect(result).toEqual({ workState: 'working', lastResponse: 'Old' })
  })

  it('falls back to assistant message text when present', () => {
    const result = parseCodexRolloutLines([
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ text: 'Final answer' }],
        },
      }),
    ])

    expect(result).toEqual({ workState: 'idle', lastResponse: 'Final answer' })
  })
})
