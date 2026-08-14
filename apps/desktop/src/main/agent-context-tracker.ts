// Keeps a live "how full is the context window" figure for every agent session,
// for the phone's session overview to render.
//
// The parsing lives in agent-context.ts; this is the bookkeeping around it —
// which transcript belongs to which orchestra session, and when to re-read it.
//
// Polled rather than watched. The tails are already watched for work state (the
// codex rollout watcher, the claude hook listener), and neither of those signals
// fires on the record we need: codex writes `token_count` between turn events,
// and claude's hooks carry no usage at all. A stat-gated poll costs one syscall
// per agent per tick when nothing has moved, and the number it produces changes
// once per turn — far slower than the tick — so nothing is gained by reacting
// faster than this.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  CLAUDE_GUESS_GRACE_MS,
  claudeProjectDir,
  findClaudeTranscript,
  parseClaudeContextTail,
  parseCodexContextTail,
  transcriptGuessFloor,
  type ContextUsage,
} from './agent-context'

/** Bytes read off the end of a transcript. The newest turn is far inside this. */
const TAIL_BYTES = 128 * 1024

/** How often each tracked transcript is stat-ed for a change. */
const DEFAULT_POLL_MS = 8_000

export interface TrackedAgentSession {
  sessionId: string
  agent: 'claude' | 'codex'
  cwd: string
}

export interface AgentContextSnapshot extends ContextUsage {
  /**
   * When the transcript was last written — the session's real "last activity",
   * and what the phone sorts its overview by. Taken from the file rather than
   * from our own read so it reflects the agent's clock, not the poll's.
   */
  updatedAt: number
}

export interface AgentContextTrackerOptions {
  /** Fired when any session's numbers changed, so the caller can re-push. */
  onChange: () => void
  /**
   * The rollout file the codex watcher has attached to this session, if any.
   * Codex's path is resolved exactly (via lsof) over there; re-deriving it here
   * would mean re-implementing that resolution and its sub-worker vetoes.
   */
  resolveCodexTranscript: (sessionId: string) => string | null
  pollIntervalMs?: number
  /** When this process came up. Defaults to construction time; tests backdate
   *  it to reach past the cold-start window and exercise the guess floor. */
  startedAt?: number
  home?: string
}

interface Entry {
  agent: 'claude' | 'codex'
  cwd: string
  /** When this entry entered tracking — the clock the guess grace and the
   *  birth-time floor both run on (see resolveFile). */
  trackedAt: number
  /** Resolved transcript, once we've found one. */
  file: string | null
  /** Path handed to us by a claude hook — authoritative, never re-guessed. */
  hookFile: string | null
  /** Last (mtime, size) read, so an untouched transcript is never re-parsed. */
  stamp: string
  snapshot: AgentContextSnapshot | null
}

export class AgentContextTracker {
  private readonly opts: AgentContextTrackerOptions
  private readonly entries = new Map<string, Entry>()
  private readonly home: string
  private readonly timer: ReturnType<typeof setInterval>
  private soon: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  // Hook-reported transcripts, by session. Outlives `entries` because the
  // report lands before the session is tracked — see noteClaudeTranscript.
  private readonly hookFiles = new Map<string, string>()
  // See the mirror's twin: sessions tracked right after this comes up are
  // pre-existing ones being re-adopted, and must not be floored.
  private readonly startedAt: number

  constructor(opts: AgentContextTrackerOptions) {
    this.opts = opts
    this.home = opts.home ?? os.homedir()
    this.startedAt = opts.startedAt ?? Date.now()
    const interval = Math.max(1_000, opts.pollIntervalMs ?? DEFAULT_POLL_MS)
    this.timer = setInterval(() => this.poll(), interval)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /**
   * Read the newcomers without waiting for the next tick — a session opened on
   * the phone should show its context immediately, not up to a poll later.
   *
   * Deferred and coalesced rather than run inline: setSessions is called from
   * the middle of the mirror push, and both the file reads and the onChange
   * re-push that a poll can trigger have no business happening there.
   */
  private pollSoon(): void {
    if (this.soon || this.stopped) return
    this.soon = setTimeout(() => {
      this.soon = null
      this.poll()
    }, 0)
    if (typeof this.soon.unref === 'function') this.soon.unref()
  }

  /**
   * Replace the tracked set with the sessions currently running an agent.
   * Sessions that dropped off (closed, or the agent exited) are forgotten along
   * with their numbers, so the phone stops showing a context figure for a
   * session that no longer has one.
   */
  setSessions(sessions: TrackedAgentSession[]): void {
    const live = new Set<string>()
    let changed = false
    for (const s of sessions) {
      live.add(s.sessionId)
      const existing = this.entries.get(s.sessionId)
      if (existing) {
        // An agent swap in the same pane (claude → codex) invalidates the
        // transcript we resolved, but not the session itself.
        if (existing.agent === s.agent && existing.cwd === s.cwd) continue
        changed = changed || existing.snapshot != null
      }
      // Claude-only, as in the message mirror: resolveFile consults hookFile
      // before the codex branch, so a claude path must never seed a codex entry.
      const reported = s.agent === 'claude' ? this.hookFiles.get(s.sessionId) ?? null : null
      this.entries.set(s.sessionId, {
        agent: s.agent,
        cwd: s.cwd,
        trackedAt: Date.now(),
        file: reported,
        hookFile: reported,
        stamp: '',
        snapshot: null,
      })
    }
    for (const id of [...this.entries.keys()]) {
      if (live.has(id)) continue
      changed = changed || this.entries.get(id)?.snapshot != null
      this.entries.delete(id)
    }
    // Deferred for the same reason as the poll: this is called from inside the
    // mirror push, and onChange re-enters it.
    if (changed || sessions.some((s) => this.entries.get(s.sessionId)?.snapshot == null)) {
      this.pollSoon()
    }
  }

  /**
   * A claude hook told us the transcript for this session. Authoritative — it
   * replaces whatever the cwd fallback guessed, and pins the pairing for good.
   *
   * Stored before the entry lookup so a report that beats tracking survives:
   * SessionStart fires while claude is booting, and the session is only tracked
   * once its OSC title identifies the agent. Dropping it meant a fresh session's
   * context figure was read off whatever transcript the cwd guess found.
   */
  noteClaudeTranscript(sessionId: string, transcriptPath: string): void {
    const resolved = path.resolve(transcriptPath)
    this.hookFiles.set(sessionId, resolved)
    const entry = this.entries.get(sessionId)
    if (!entry || entry.agent !== 'claude') return
    if (entry.hookFile === resolved) return
    entry.hookFile = resolved
    entry.file = resolved
    entry.stamp = ''
    this.pollSoon()
  }

  /** Current numbers per session, for the mirror. */
  getAll(): Record<string, AgentContextSnapshot> {
    const out: Record<string, AgentContextSnapshot> = {}
    for (const [id, entry] of this.entries) {
      if (entry.snapshot) out[id] = entry.snapshot
    }
    return out
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    this.soon = null
    this.entries.clear()
    this.hookFiles.clear()
  }

  private poll(): void {
    let changed = false
    for (const [sessionId, entry] of this.entries) {
      if (this.refresh(sessionId, entry)) changed = true
    }
    if (changed) this.opts.onChange()
  }

  /** Re-read one session's transcript if it has moved. True when the numbers changed. */
  private refresh(sessionId: string, entry: Entry): boolean {
    const file = this.resolveFile(sessionId, entry)
    if (!file) return false
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      // The transcript vanished (worktree deleted, history cleared). Drop the
      // resolution so the next tick can find a replacement, but keep the last
      // numbers — they were true when read, and blanking the card on a
      // transient stat failure would read as the agent losing its context.
      entry.file = entry.hookFile
      return false
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`
    if (stamp === entry.stamp) return false
    entry.stamp = stamp

    const tail = readTail(file, TAIL_BYTES)
    if (!tail) return false
    const usage =
      entry.agent === 'claude'
        ? parseClaudeContextTail(tail.text, tail.partial)
        : parseCodexContextTail(tail.text, tail.partial)
    if (!usage) return false

    const previous = entry.snapshot
    entry.snapshot = { ...usage, updatedAt: Math.round(stat.mtimeMs) }
    return (
      !previous ||
      previous.usedTokens !== usage.usedTokens ||
      previous.contextWindow !== usage.contextWindow ||
      previous.model !== usage.model ||
      previous.effort !== usage.effort ||
      previous.updatedAt !== entry.snapshot.updatedAt
    )
  }

  private resolveFile(sessionId: string, entry: Entry): string | null {
    if (entry.hookFile) return entry.hookFile
    if (entry.agent === 'codex') {
      // Always re-ask: the watcher re-attaches when codex swaps rollout files
      // (resume, restart in the same pane), and a stale pin would freeze the
      // number on the abandoned transcript.
      const file = this.opts.resolveCodexTranscript(sessionId)
      if (file && file !== entry.file) {
        entry.file = file
        entry.stamp = ''
      }
      return entry.file
    }
    if (entry.file) return entry.file
    // Give SessionStart its window before guessing. Without it a fresh session
    // reads its context percentage off whatever conversation the fallback
    // lands on — the number half of the foreign-pairing bug.
    if (Date.now() - entry.trackedAt < CLAUDE_GUESS_GRACE_MS) return null
    const dir = claudeProjectDir(entry.cwd, this.home)
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return null
    }
    // Don't hand two sessions the same transcript — see findClaudeTranscript.
    const claimedPaths: string[] = []
    for (const [id, other] of this.entries) {
      if (id !== sessionId && other.agent === 'claude' && other.file) claimedPaths.push(other.file)
    }
    const file = findClaudeTranscript(
      dir,
      names,
      (name) => {
        try {
          const st = fs.statSync(path.join(dir, name))
          return { mtimeMs: st.mtimeMs, createdMs: st.birthtimeMs || st.mtimeMs }
        } catch {
          return null
        }
      },
      claimedPaths,
      transcriptGuessFloor(this.startedAt, entry.trackedAt),
    )
    if (!file) return null
    entry.file = file
    entry.stamp = ''
    return entry.file
  }
}

/**
 * The last `maxBytes` of a file. `partial` says whether the read landed inside a
 * line — the caller drops that first fragment rather than trying to parse it.
 */
function readTail(file: string, maxBytes: number): { text: string; partial: boolean } | null {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const size = fs.fstatSync(fd).size
    const length = Math.min(size, maxBytes)
    if (length <= 0) return null
    const start = size - length
    const buf = Buffer.allocUnsafe(length)
    fs.readSync(fd, buf, 0, length, start)
    return { text: buf.toString('utf8'), partial: start > 0 }
  } catch {
    return null
  } finally {
    try {
      fs.closeSync(fd)
    } catch {}
  }
}
