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

  it('settles to idle when the turn is aborted', () => {
    const result = parseCodexRolloutLines([
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ text: 'Partial answer' }],
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }),
    ])

    expect(result).toEqual({ workState: 'idle', lastResponse: 'Partial answer' })
  })

  it('treats approval requests as a distinct waiting state', () => {
    const result = parseCodexRolloutLines([
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'exec_command_approval_request' } }),
    ])

    expect(result).toEqual({ workState: 'waitingApproval', lastResponse: '' })
  })

  it('treats explicit user-input requests as a distinct waiting state', () => {
    const result = parseCodexRolloutLines([
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'request_user_input' } }),
    ])

    expect(result).toEqual({ workState: 'waitingUserInput', lastResponse: '' })
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
