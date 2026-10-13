// src/main/session-origin.ts
// Which sessions an agent opened through Orchestra's MCP server (origin 'mcp').
// Fed from the renderer's realtime mirror (remoteBridgeOnMirror), so a session is
// known the moment it exists; the disk copy trails by up to a second of save
// throttle and is only the fallback before the first mirror arrives.

import type { TerminalSession } from '../shared/types'

let agentSessions: ReadonlySet<string> | null = null

export function noteSessionOrigins(sessions: Record<string, Pick<TerminalSession, 'origin'>>): void {
  agentSessions = new Set(Object.keys(sessions).filter((id) => sessions[id]?.origin === 'mcp'))
}

/**
 * Agent-opened sessions never alert the user: no toast, sound, dock bounce,
 * native notification, interruption popup or phone push (see idle-notifier).
 */
export function isAgentOriginSession(sessionId: string): boolean {
  if (agentSessions) return agentSessions.has(sessionId)
  try {
    const { loadPersistedData } = require('./persistence') as typeof import('./persistence')
    return loadPersistedData().sessions[sessionId]?.origin === 'mcp'
  } catch {
    return false
  }
}
