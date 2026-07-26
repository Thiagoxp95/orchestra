// Pure helpers for the web→desktop resume flow: shrinking the on-disk recent
// agent sessions into a payload small enough to hand a phone, and normalizing
// the `resumeAgentSession` command that comes back. Kept free of Electron
// imports so they are unit-testable, like the other bridge helpers.

import type { RecentAgentSession } from '../shared/types'

/**
 * Entries mirrored to the web. Enough to cover every workspace and worktree
 * worked in recently without the row growing unwieldy — the whole listing is one
 * Convex document.
 */
export const REMOTE_SESSION_LIMIT = 250
/** Preview text per entry; the phone shows two clipped lines at most. */
export const REMOTE_SUMMARY_CAP = 180

export interface RemoteAgentSession {
  agent: 'claude' | 'codex'
  sessionId: string
  cwd: string
  cwdExists: boolean
  gitBranch: string | null
  updatedAt: number
  title: string | null
  /** Last thing said in the conversation, whichever side said it. */
  summary: string | null
  /** True when `summary` is the user's own message (the phone prefixes "You:"). */
  summaryIsUser: boolean
}

function clip(text: string | null, max: number): string | null {
  if (!text) return null
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/** Newest-first, capped, and stripped of anything the phone can't use (file paths). */
export function toRemoteAgentSessions(sessions: RecentAgentSession[]): RemoteAgentSession[] {
  return [...sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, REMOTE_SESSION_LIMIT)
    .map((session) => ({
      agent: session.agent,
      sessionId: session.sessionId,
      cwd: session.cwd,
      cwdExists: session.cwdExists,
      gitBranch: session.gitBranch,
      updatedAt: session.updatedAt,
      title: clip(session.title, 90),
      summary: clip(session.lastAssistantMessage ?? session.lastUserMessage, REMOTE_SUMMARY_CAP),
      summaryIsUser: !session.lastAssistantMessage && !!session.lastUserMessage,
    }))
}

export interface ResumeAgentSessionPayload {
  agent: 'claude' | 'codex'
  sessionId: string
  cwd: string
}

/**
 * Validate a `resumeAgentSession` payload. Null for anything unusable — the
 * command spawns a shell command built from these fields, so a half-filled
 * payload must not reach the renderer.
 */
export function normalizeResumeSessionPayload(payload: unknown): ResumeAgentSessionPayload | null {
  const p = (payload ?? {}) as Record<string, unknown>
  const agent = p.agent === 'claude' || p.agent === 'codex' ? p.agent : null
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId.trim() : ''
  const cwd = typeof p.cwd === 'string' ? p.cwd.trim() : ''
  if (!agent || !sessionId || !cwd) return null
  return { agent, sessionId, cwd }
}
