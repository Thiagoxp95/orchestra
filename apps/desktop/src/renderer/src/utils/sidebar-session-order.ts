import type { NormalizedAgentSessionStatus, TerminalSession } from '../../../shared/types'

interface SidebarSessionOrderOptions {
  getNormalizedState: (sessionId: string) => NormalizedAgentSessionStatus | null
}

function getSessionAttentionPriority(
  session: Pick<TerminalSession, 'id'>,
  { getNormalizedState }: SidebarSessionOrderOptions,
): number {
  const state = getNormalizedState(session.id)
  if (!state) return 2

  if (state.state === 'waitingUserInput') return 0
  if (state.state === 'waitingApproval') return 1
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
