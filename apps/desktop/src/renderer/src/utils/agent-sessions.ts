import type { TerminalSession } from '../../../shared/types'

type OriginLookup = Record<string, Pick<TerminalSession, 'origin'> | undefined>

/**
 * The ids a session list shows. Sessions an agent opened through Orchestra's MCP
 * server (origin 'mcp') stay out of every list, count and cycle order unless
 * settings.showAgentSessions is on. The session on screen is always listed:
 * focusing one by id (MCP focus, a notification click) must still show where
 * you are. Only for display — killing a tree or workspace still takes all ids.
 */
export function listedSessionIds(
  ids: string[],
  sessions: OriginLookup,
  showAgentSessions: boolean | undefined,
  activeSessionId: string | null,
): string[] {
  if (showAgentSessions) return ids
  return ids.filter((id) => sessions[id]?.origin !== 'mcp' || id === activeSessionId)
}

/** How many agent (MCP) sessions exist — the toggle's count. */
export function countAgentSessions(sessions: OriginLookup): number {
  return Object.values(sessions).filter((s) => s?.origin === 'mcp').length
}
