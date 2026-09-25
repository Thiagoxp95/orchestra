// src/main/local-server/runtime-state.ts
//
// Everything the phone reads that is NOT durable: the desktop state mirror and
// the three request/fulfill flows (dictation, ticket drafts, agent session
// listings). None of it is written to disk — it is either a projection of live
// desktop state or a short-lived exchange, so a restart correctly loses it.
//
// Under Convex each of these was a table written by one process and read by
// another. In-process they are plain maps, and "notify the phone" is a
// synchronous invalidate instead of a database round trip.

import type { DictationStatus } from '../../shared/dictation'

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

// ── Dictation ────────────────────────────────────────────────────────────

export interface DictationRecord {
  dictationId: string
  sessionId: string
  status: DictationStatus
  finalText?: string
  error?: string
  chunkCount?: number
  createdAt: number
  updatedAt: number
}

export interface DictationChunk {
  seq: number
  pcm: string
}

const dictations = new Map<string, DictationRecord>()
const dictationChunks = new Map<string, Map<number, DictationChunk>>()

/** Fires when an utterance starts or ends, replacing the pendingDictation subscription. */
let onDictationPending: (() => void) | null = null

export function onDictationChange(fn: (() => void) | null): void {
  onDictationPending = fn
}

export function startDictation(dictationId: string, sessionId: string): void {
  if (dictations.has(dictationId)) return // idempotent on retry
  const now = Date.now()
  dictations.set(dictationId, { dictationId, sessionId, status: 'recording', createdAt: now, updatedAt: now })
  invalidate('remoteDictation.dictationStatus')
  onDictationPending?.()
}

export function appendDictationChunk(dictationId: string, seq: number, pcm: string): void {
  const record = dictations.get(dictationId)
  // Throw rather than ignore: the client retries, and swallowing a chunk that
  // lost the race with startDictation is how the first word used to vanish.
  if (!record) throw new Error('dictation not started')
  if (record.status !== 'recording') return // dropped after end
  const chunks = dictationChunks.get(dictationId) ?? new Map<number, DictationChunk>()
  if (chunks.has(seq)) return // idempotent on resend
  chunks.set(seq, { seq, pcm })
  dictationChunks.set(dictationId, chunks)
}

export function endDictation(dictationId: string, chunkCount?: number): void {
  const record = dictations.get(dictationId)
  if (!record || record.status !== 'recording') return
  record.status = 'ended'
  if (chunkCount !== undefined) record.chunkCount = chunkCount
  record.updatedAt = Date.now()
  invalidate('remoteDictation.dictationStatus')
  onDictationPending?.()
}

function isTerminal(status: DictationStatus): boolean {
  return status === 'done' || status === 'cancelled' || status === 'error'
}

export function cancelDictation(dictationId: string): void {
  const record = dictations.get(dictationId)
  if (!record || isTerminal(record.status)) return
  record.status = 'cancelled'
  record.updatedAt = Date.now()
  invalidate('remoteDictation.dictationStatus')
  // The orchestrator learns of a cancel by the record leaving the pending set.
  onDictationPending?.()
}

export function finalizeDictation(dictationId: string, finalText: string): void {
  const record = dictations.get(dictationId)
  // A user cancel mid-transcription wins; don't resurrect a cancelled row.
  if (!record || isTerminal(record.status)) return
  record.status = 'done'
  record.finalText = finalText
  record.updatedAt = Date.now()
  invalidate('remoteDictation.dictationStatus')
}

export function failDictation(dictationId: string, error: string): void {
  const record = dictations.get(dictationId)
  if (!record || isTerminal(record.status)) return
  record.status = 'error'
  record.error = error
  record.updatedAt = Date.now()
  invalidate('remoteDictation.dictationStatus')
}

export function getDictation(dictationId: string): DictationRecord | null {
  return dictations.get(dictationId) ?? null
}

/** Utterances the desktop still has work to do on, oldest first. */
export function pendingDictations(): DictationRecord[] {
  return [...dictations.values()]
    .filter((row) => row.status === 'recording' || row.status === 'ended')
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function getDictationChunks(dictationId: string, afterSeq: number): DictationChunk[] {
  const chunks = dictationChunks.get(dictationId)
  if (!chunks) return []
  return [...chunks.values()]
    .filter((chunk) => chunk.seq > afterSeq)
    .sort((a, b) => a.seq - b.seq)
    .slice(0, 200)
}

export function deleteDictationChunks(dictationId: string): void {
  dictationChunks.delete(dictationId)
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

const DICTATION_TTL_MS = 5 * 60_000
const REQUEST_TTL_MS = 15 * 60_000

/**
 * Drop finished exchanges. Replaces the 5-minute `pruneRemote` cron; there is
 * far less to do now that terminal output and commands never become rows.
 */
export function reapRuntimeState(now: number = Date.now()): void {
  for (const [id, row] of dictations) {
    if (isTerminal(row.status) && now - row.updatedAt > DICTATION_TTL_MS) {
      dictations.delete(id)
      dictationChunks.delete(id)
    }
  }
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
  dictations.clear()
  dictationChunks.clear()
  ticketDrafts.clear()
  agentSessions.clear()
}
