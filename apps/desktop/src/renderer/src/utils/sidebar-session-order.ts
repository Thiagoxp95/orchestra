import type { CodexWorkState, TerminalSession } from '../../../shared/types'

interface SidebarSessionOrderOptions {
  getCodexSessionState: (sessionId: string) => CodexWorkState
  sessionNeedsUserInput: Record<string, boolean>
}

function getSessionAttentionPriority(
  session: Pick<TerminalSession, 'id'>,
  { getCodexSessionState, sessionNeedsUserInput }: SidebarSessionOrderOptions,
): number {
  const codexState = getCodexSessionState(session.id)
  const needsUserInput = codexState === 'waitingUserInput' || sessionNeedsUserInput[session.id] === true

  if (needsUserInput) return 0
  if (codexState === 'waitingApproval') return 1
  return 2
}

export function sortSessionsForSidebar<T extends Pick<TerminalSession, 'id'>>(
  sessions: T[],
  options: SidebarSessionOrderOptions,
): T[] {
  return sessions
    .map((session, index) => ({
      session,
      index,
      priority: getSessionAttentionPriority(session, options),
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map(({ session }) => session)
}
