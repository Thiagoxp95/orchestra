import { describe, expect, it } from 'vitest'
import { countAgentSessions, hideAgentSessions } from './agent-sessions'
import { flattenRoll } from './session-roll'

const sessions = {
  mine: { label: 'Claude 1', processStatus: 'claude', workspaceId: 'w1' },
  bot: { label: 'Claude 2', processStatus: 'claude', workspaceId: 'w1', origin: 'mcp' },
  botWt: { label: 'Terminal 1', processStatus: 'terminal', workspaceId: 'w1', origin: 'mcp' },
}
const workspaces = [
  {
    id: 'w1',
    name: 'Repo',
    trees: [
      { rootDir: '/repo', sessionIds: ['mine', 'bot'] },
      { rootDir: '/repo-wt', sessionIds: ['botWt'] },
    ],
  },
]

describe('hideAgentSessions', () => {
  it('drops agent sessions from every tree by default', () => {
    const listed = hideAgentSessions(workspaces, sessions, false, null)
    expect(listed[0].trees.map((t) => t.sessionIds)).toEqual([['mine'], []])
    // The roll and overview are built from the listed trees, so they lose them too.
    expect(flattenRoll(listed, sessions, {}).map((i) => i.sessionId)).toEqual(['mine'])
  })

  it('shows everything when the toggle is on, without copying', () => {
    expect(hideAgentSessions(workspaces, sessions, true, null)).toBe(workspaces)
  })

  it('keeps the agent session that is open (push tap, ?session= link)', () => {
    const listed = hideAgentSessions(workspaces, sessions, false, 'bot')
    expect(listed[0].trees[0].sessionIds).toEqual(['mine', 'bot'])
  })

  it('returns the input untouched when there is nothing to hide', () => {
    const userOnly = [{ trees: [{ sessionIds: ['mine'] }] }]
    expect(hideAgentSessions(userOnly, sessions, false, null)).toBe(userOnly)
  })

  it('counts agent sessions for the toggle', () => {
    expect(countAgentSessions(sessions)).toBe(2)
  })
})
