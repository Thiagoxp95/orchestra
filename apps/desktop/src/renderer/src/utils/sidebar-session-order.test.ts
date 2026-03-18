import { describe, expect, it } from 'vitest'
import type { CodexWorkState, TerminalSession } from '../../../shared/types'
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

function sortWithCodexState(
  sessions: TerminalSession[],
  codexStates: Record<string, CodexWorkState>,
  sessionNeedsUserInput: Record<string, boolean> = {},
): string[] {
  return sortSessionsForSidebar(sessions, {
    getCodexSessionState: (sessionId) => codexStates[sessionId] ?? 'idle',
    sessionNeedsUserInput,
  }).map((session) => session.id)
}

describe('sortSessionsForSidebar', () => {
  it('keeps working sessions in their original position', () => {
    const sessions = ['session-1', 'session-2', 'session-3', 'session-4', 'session-5'].map(makeSession)

    expect(sortWithCodexState(sessions, {
      'session-4': 'working',
    })).toEqual(['session-1', 'session-2', 'session-3', 'session-4', 'session-5'])
  })

  it('still floats reply-needed and approval-needed sessions to the top', () => {
    const sessions = ['session-1', 'session-2', 'session-3', 'session-4'].map(makeSession)

    expect(sortWithCodexState(sessions, {
      'session-2': 'waitingApproval',
      'session-4': 'working',
    }, {
      'session-3': true,
    })).toEqual(['session-3', 'session-2', 'session-1', 'session-4'])
  })
})
