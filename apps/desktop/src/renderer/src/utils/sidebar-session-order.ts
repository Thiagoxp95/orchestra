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

/**
 * Sidebar order within one worktree: pinned sessions first as their own block,
 * then whoever needs you, then spawn order.
 *
 * Pinning outranks attention deliberately. Attention order is the list
 * rearranging itself under you; a pin is the user saying "this one stays put",
 * and a pin that a notification can shove down the list isn't a pin. Within each
 * block attention still sorts, so a pinned session waiting on you rises to the
 * very top. Order is computed here rather than by reordering `tree.sessionIds`,
 * so unpinning drops a session back exactly where it was.
 */
export function sortSessionsForSidebar<T extends Pick<TerminalSession, 'id'> & { pinned?: boolean }>(
  sessions: T[],
  options: SidebarSessionOrderOptions,
): T[] {
  return sessions
    .map((session, index) => ({
      session,
      index,
      pinRank: session.pinned ? 0 : 1,
      priority: getSessionAttentionPriority(session, options),
    }))
    .sort((a, b) => a.pinRank - b.pinRank || a.priority - b.priority || a.index - b.index)
    .map(({ session }) => session)
}
