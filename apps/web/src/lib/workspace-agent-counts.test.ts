import { describe, it, expect } from 'vitest'
import { workspaceAgentCounts } from './workspace-agent-counts'

const ws = { trees: [{ sessionIds: ['a', 'b'] }, { sessionIds: ['c', 'd', 'e', 'f'] }] }
const sessions = {
  a: { processStatus: 'claude' },
  b: { processStatus: 'codex' },
  c: { processStatus: 'claude' },
  d: { processStatus: 'cursor' },
  e: { processStatus: 'terminal' },
  f: { processStatus: 'claude' },
}

describe('workspaceAgentCounts', () => {
  it('puts every live agent in exactly one bucket', () => {
    const counts = workspaceAgentCounts(ws, sessions, {
      a: { work: 'working' },
      b: { work: 'idle', attention: 'input' },
      c: { work: 'idle' },
      e: { work: 'working' },
      f: { exited: true, attention: 'input' },
    })
    expect(counts).toEqual({
      working: { count: 1, agent: 'claude' },
      needsInput: { count: 1, agent: 'codex' },
      // c is idle; d has no mirrored status yet and still counts.
      idle: { count: 2, agent: 'claude' },
    })
  })

  it('keeps a finished turn whose ask was acknowledged as idle, not gone', () => {
    const counts = workspaceAgentCounts({ trees: [{ sessionIds: ['a'] }] }, sessions, { a: { work: 'idle' } })
    expect(counts.idle.count).toBe(1)
  })
})
