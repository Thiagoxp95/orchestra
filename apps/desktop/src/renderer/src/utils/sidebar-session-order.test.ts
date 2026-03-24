import { describe, expect, it } from 'vitest'
import type { TerminalSession } from '../../../shared/types'
import type { AgentSessionState, NormalizedAgentSessionStatus } from '../../../shared/agent-session-types'
import { sortSessionsForSidebar } from './sidebar-session-order'

function makeSession(id: string): TerminalSession {
  return {
    id,
    workspaceId: 'workspace-1',
    label: id,
    processStatus: 'codex',
    cwd: '/tmp/repo',
    shellPath: '/bin/zsh',
  }
}

function makeNormalizedState(sessionId: string, state: AgentSessionState): NormalizedAgentSessionStatus {
  return {
    sessionId,
    agent: 'codex',
    state,
    authority: 'codex-watcher-fallback',
    connected: true,
    lastResponsePreview: '',
    lastTransitionAt: 0,
    updatedAt: 0,
  }
}

function sortWithState(
  sessions: TerminalSession[],
  states: Record<string, AgentSessionState>,
): string[] {
  return sortSessionsForSidebar(sessions, {
    getNormalizedState: (sessionId) => {
      const state = states[sessionId]
      return state ? makeNormalizedState(sessionId, state) : null
    },
  }).map((session) => session.id)
}

describe('sortSessionsForSidebar', () => {
  it('keeps working sessions in their original position', () => {
    const sessions = ['session-1', 'session-2', 'session-3', 'session-4', 'session-5'].map(makeSession)

    expect(sortWithState(sessions, {
      'session-4': 'working',
    })).toEqual(['session-1', 'session-2', 'session-3', 'session-4', 'session-5'])
  })

  it('still floats reply-needed and approval-needed sessions to the top', () => {
    const sessions = ['session-1', 'session-2', 'session-3', 'session-4'].map(makeSession)

    expect(sortWithState(sessions, {
      'session-2': 'waitingApproval',
      'session-3': 'waitingUserInput',
      'session-4': 'working',
    })).toEqual(['session-3', 'session-2', 'session-1', 'session-4'])
  })
})
