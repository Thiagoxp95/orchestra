import type { TerminalSession } from '../../../shared/types'
import type { NormalizedAgentSessionStatus } from '../../../shared/agent-session-types'

interface SidebarSessionOrderOptions {
  getNormalizedState: (sessionId: string) => NormalizedAgentSessionStatus | null
  getSessionNeedsUserInput?: (sessionId: string) => boolean
}

function getSessionAttentionPriority(
  session: Pick<TerminalSession, 'id'>,
  { getNormalizedState, getSessionNeedsUserInput }: SidebarSessionOrderOptions,
): number {
  const state = getNormalizedState(session.id)
  if (state?.state === 'waitingUserInput' || getSessionNeedsUserInput?.(session.id)) return 0
  if (state?.state === 'waitingApproval') return 1
  if (!state) return 2
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
