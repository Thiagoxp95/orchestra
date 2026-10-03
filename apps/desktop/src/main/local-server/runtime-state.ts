// src/main/local-server/runtime-state.ts
//
// Everything the phone reads that is NOT durable: the desktop state mirror and
// the two request/fulfill flows (ticket drafts, agent session listings). None of it is written to disk — it is either a projection of live
// desktop state or a short-lived exchange, so a restart correctly loses it.
//
// Under Convex each of these was a table written by one process and read by
// another. In-process they are plain maps, and "notify the phone" is a
// synchronous invalidate instead of a database round trip.

/** Called with the query names whose value may have changed. */
export type InvalidateFn = (...names: string[]) => void

let invalidate: InvalidateFn = () => {}

export function setInvalidator(fn: InvalidateFn): void {
  invalidate = fn
}

// ── Desktop state mirror ─────────────────────────────────────────────────

/** The payload the phone renders. Assembled by remote-bridge's publishState. */
export interface RemoteStateSnapshot {
  workspaces: unknown
  sessions: Record<string, unknown>
  liveStatus: unknown
  activeWorkspaceId: string | null
  activeSessionId: string | null
  geometryOwner: string
  geometryEpoch: number
  usage?: unknown
  slashCommands?: unknown
  servers?: unknown
  updateStatus?: unknown
  /** Wall clock of the last publish. The phone's "desktop offline" banner
   *  keys off this, so it must advance on every heartbeat, not just changes. */
  updatedAt: number
}

let remoteState: RemoteStateSnapshot | null = null

export function setRemoteState(snapshot: Omit<RemoteStateSnapshot, 'updatedAt'>): void {
  remoteState = { ...snapshot, updatedAt: Date.now() }
  invalidate('remote.getRemoteState')
}

export function getRemoteState(): RemoteStateSnapshot | null {
  return remoteState
}

/** Does this session exist in the mirror? Gates relay viewers. */
export function hasMirroredSession(sessionId: string): boolean {
  return Boolean(remoteState && Object.prototype.hasOwnProperty.call(remoteState.sessions, sessionId))
}

export function clearRemoteState(): void {
  remoteState = null
  invalidate('remote.getRemoteState')
}

// ── Ticket drafts ────────────────────────────────────────────────────────

export type TicketDraftStatus = 'generating' | 'ready' | 'creating' | 'created' | 'error' | 'cancelled'

export interface TicketDraftRecord {
  requestId: string
  sessionId: string
  status: TicketDraftStatus
  draft?: unknown
  viewer?: unknown
  projects?: unknown
  labels?: unknown
  result?: unknown
  error?: string
  createdAt: number
  updatedAt: number
}

const ticketDrafts = new Map<string, TicketDraftRecord>()

export function startTicketDraft(requestId: string, sessionId: string): void {
  if (ticketDrafts.has(requestId)) return // idempotent on retry
  const now = Date.now()
  ticketDrafts.set(requestId, { requestId, sessionId, status: 'generating', createdAt: now, updatedAt: now })
  invalidate('ticketDrafts.getTicketDraft')
}

export function getTicketDraft(requestId: string): TicketDraftRecord | null {
  return ticketDrafts.get(requestId) ?? null
}

export function cancelTicketDraft(requestId: string): void {
  const row = ticketDrafts.get(requestId)
  // Terminal states stay put; anything mid-flight becomes cancelled so the
  // desktop drops it if it hasn't finished yet.
  if (!row || row.status === 'created' || row.status === 'error') return
  row.status = 'cancelled'
  row.updatedAt = Date.now()
  invalidate('ticketDrafts.getTicketDraft')
}

export function finalizeTicketDraft(
  requestId: string,
  fields: { draft: unknown; viewer: unknown; projects: unknown; labels: unknown },
): void {
  const row = ticketDrafts.get(requestId)
  if (!row || row.status !== 'generating') return
  Object.assign(row, fields, { status: 'ready' as const, updatedAt: Date.now() })
  invalidate('ticketDrafts.getTicketDraft')
}

export function setTicketDraftStatus(
  requestId: string,
  status: 'creating' | 'created' | 'error',
  extra: { result?: unknown; error?: string } = {},
): void {
  const row = ticketDrafts.get(requestId)
  if (!row) return
  row.status = status
  if (extra.result !== undefined) row.result = extra.result
  if (extra.error !== undefined) row.error = extra.error
  row.updatedAt = Date.now()
  invalidate('ticketDrafts.getTicketDraft')
}

// ── Agent session listings ───────────────────────────────────────────────

export interface AgentSessionsRecord {
  requestId: string
  status: 'loading' | 'ready' | 'error'
  sessions?: unknown
  error?: string
  createdAt: number
  updatedAt: number
}

const agentSessions = new Map<string, AgentSessionsRecord>()

export function requestAgentSessions(requestId: string): void {
  if (agentSessions.has(requestId)) return // idempotent on retry
  const now = Date.now()
  agentSessions.set(requestId, { requestId, status: 'loading', createdAt: now, updatedAt: now })
  invalidate('agentSessions.getAgentSessions')
}

export function getAgentSessions(requestId: string): AgentSessionsRecord | null {
  return agentSessions.get(requestId) ?? null
}

export function fulfillAgentSessions(requestId: string, sessions: unknown): void {
  const row = agentSessions.get(requestId)
  if (!row) return
  Object.assign(row, { status: 'ready' as const, sessions, updatedAt: Date.now() })
  invalidate('agentSessions.getAgentSessions')
}

export function failAgentSessions(requestId: string, error: string): void {
  const row = agentSessions.get(requestId)
  if (!row) return
  Object.assign(row, { status: 'error' as const, error, updatedAt: Date.now() })
  invalidate('agentSessions.getAgentSessions')
}

// ── Reaping ──────────────────────────────────────────────────────────────

const REQUEST_TTL_MS = 15 * 60_000

/**
 * Drop finished exchanges. Replaces the 5-minute `pruneRemote` cron; there is
 * far less to do now that terminal output and commands never become rows.
 */
export function reapRuntimeState(now: number = Date.now()): void {
  for (const [id, row] of ticketDrafts) {
    if (now - row.updatedAt > REQUEST_TTL_MS) ticketDrafts.delete(id)
  }
  for (const [id, row] of agentSessions) {
    if (now - row.updatedAt > REQUEST_TTL_MS) agentSessions.delete(id)
  }
}

/** Test seam. */
export function resetRuntimeState(): void {
  remoteState = null
  ticketDrafts.clear()
  agentSessions.clear()
}
