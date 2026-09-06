// Remembers which conversation each session pane is holding, so the pane can
// offer to reopen it after its process is gone.
//
// The problem this solves is a reboot. Session rows are persisted; PTYs are not.
// On the next launch every row comes back looking like an agent and relaunches a
// FRESH one — the conversation it had is still on disk, but nothing tied the two
// together. This tracker writes that link down while the session is alive, and
// the row persists it, so a restored row knows its own conversation id.
//
// It resolves nothing itself for claude and codex: the context tracker already
// pairs those to a transcript (hook path first, then codex's rollout watcher,
// then the cwd fallback), and this reads the id out of the path it settled on.
// Cursor has no such pairing — it writes SQLite, so there is no transcript to
// tail for context — so its lookup is done here, off the chats directory.

import * as os from 'node:os'
import type { ResumableAgent } from '../shared/types'
import { agentSessionIdFromTranscript, findCursorChat } from './agent-resume-ids'

export interface ResumeTrackedSession {
  sessionId: string
  agent: ResumableAgent
  cwd: string
}

export interface SessionResumePairing {
  agent: ResumableAgent
  /** The CLI's own conversation id — what `--resume` takes. */
  resumeSessionId: string
}

export interface SessionResumeTrackerOptions {
  /**
   * The transcript the context tracker has paired with a session, if any.
   * Claude and codex only; cursor is resolved here.
   */
  resolveTranscript: (sessionId: string) => string | null
  /** Fired for each session whose pairing changed, so it can be persisted. */
  onPairing: (sessionId: string, pairing: SessionResumePairing) => void
  /** When this process came up. Tests backdate it to reach past cold start. */
  startedAt?: number
  home?: string
  now?: () => number
}

/**
 * How long after this process starts a session counts as "already running" —
 * one it adopted rather than launched. Matches the context tracker's own
 * cold-start carve-out, and for the same reason: sessions restored on launch
 * have conversations older than the launch, and flooring them would leave every
 * one of them unpairable.
 */
const ADOPTION_WINDOW_MS = 30_000

interface Entry {
  agent: ResumableAgent
  cwd: string
  /** When this pane entered tracking — the floor a cursor chat has to clear. */
  trackedAt: number
  /** True when the pane predates this process, so no floor applies. */
  adopted: boolean
  resumeSessionId: string | null
}

export class SessionResumeTracker {
  private readonly opts: SessionResumeTrackerOptions
  private readonly home: string
  private readonly now: () => number
  private readonly startedAt: number
  private readonly entries = new Map<string, Entry>()

  constructor(opts: SessionResumeTrackerOptions) {
    this.opts = opts
    this.home = opts.home ?? os.homedir()
    this.now = opts.now ?? Date.now
    this.startedAt = opts.startedAt ?? this.now()
  }

  /**
   * Re-derive the pairing for every live agent session, reporting the ones that
   * moved. Called from the mirror push, which is also where the context tracker
   * is re-aimed, so a transcript it resolved on the previous tick is visible by
   * the time this runs.
   *
   * A session leaving the set keeps its pairing: a pane losing its agent (the
   * CLI exited, the machine went down) is exactly when its conversation id
   * becomes worth having. Only `forget` drops one.
   */
  update(sessions: ResumeTrackedSession[]): void {
    const now = this.now()
    for (const session of sessions) {
      let entry = this.entries.get(session.sessionId)
      if (!entry || entry.agent !== session.agent || entry.cwd !== session.cwd) {
        // A pane that swapped agent or moved has a different conversation now.
        entry = {
          agent: session.agent,
          cwd: session.cwd,
          trackedAt: now,
          adopted: now - this.startedAt < ADOPTION_WINDOW_MS,
          resumeSessionId: null,
        }
        this.entries.set(session.sessionId, entry)
      }
      const resumeSessionId = this.resolve(session.sessionId, entry)
      if (!resumeSessionId || resumeSessionId === entry.resumeSessionId) continue
      entry.resumeSessionId = resumeSessionId
      this.opts.onPairing(session.sessionId, { agent: entry.agent, resumeSessionId })
    }
  }

  /** The conversation a session would resume, as last resolved. */
  get(sessionId: string): SessionResumePairing | null {
    const entry = this.entries.get(sessionId)
    if (!entry?.resumeSessionId) return null
    return { agent: entry.agent, resumeSessionId: entry.resumeSessionId }
  }

  /** Forget a session for good — the pane was closed, not just its process. */
  forget(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  private resolve(sessionId: string, entry: Entry): string | null {
    if (entry.agent !== 'cursor') {
      const file = this.opts.resolveTranscript(sessionId)
      return file ? agentSessionIdFromTranscript(entry.agent, file) : null
    }
    // Pinned once found. Cursor exposes no session id to the terminal at all, so
    // recency is the only evidence there is, and re-reading it every tick would
    // let a chat started in another pane (or outside orchestra entirely) walk
    // off with this pane's pairing.
    if (entry.resumeSessionId) return entry.resumeSessionId
    const claimed: string[] = []
    for (const [id, other] of this.entries) {
      if (id !== sessionId && other.agent === 'cursor' && other.resumeSessionId) {
        claimed.push(other.resumeSessionId)
      }
    }
    const chat = findCursorChat(entry.cwd, this.home, claimed)
    if (!chat) return null
    // A freshly launched pane must not adopt the conversation that was already
    // sitting in this folder — the chat has to have been written since the pane
    // opened. Panes this process adopted at launch have no such evidence
    // available (their chat predates us), so the floor doesn't apply to them.
    if (!entry.adopted && chat.updatedAt < entry.trackedAt) return null
    return chat.chatId
  }
}
