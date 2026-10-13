import { describe, expect, it } from 'vitest'
import { countAgentSessions, listedSessionIds } from './agent-sessions'

const sessions = { mine: {}, old: { origin: 'user' as const }, bot: { origin: 'mcp' as const }, bot2: { origin: 'mcp' as const } }
const ids = ['mine', 'old', 'bot', 'bot2']

describe('listedSessionIds', () => {
  it('hides agent sessions by default', () => {
    expect(listedSessionIds(ids, sessions, undefined, null)).toEqual(['mine', 'old'])
  })

  it('shows them all when the toggle is on', () => {
    expect(listedSessionIds(ids, sessions, true, null)).toEqual(ids)
  })

  it('keeps the agent session on screen listed', () => {
    expect(listedSessionIds(ids, sessions, false, 'bot2')).toEqual(['mine', 'old', 'bot2'])
  })

  it('counts agent sessions for the toggle', () => {
    expect(countAgentSessions(sessions)).toBe(2)
  })
})
