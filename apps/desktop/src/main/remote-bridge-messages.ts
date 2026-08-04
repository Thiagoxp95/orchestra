// Tails every tracked agent session's transcript and mirrors it to Convex as
// structured ChatMessages — the data feed for the phone's chat view.
//
// Follows the AgentContextTracker pattern deliberately: same TrackedAgentSession
// shape, same "re-aimed on every push" lifecycle, same hook-first/cwd-fallback
// transcript resolution for Claude, same injected codex resolution. The Convex
// calls are injected too, so the whole tail-parse-push pipeline is testable
// against temp files and fake functions without touching the network.
//
// The parsing lives in agent-message-model.ts; this is the bookkeeping around
// it — which file to read, how much of it has been consumed, and when the
// parsed messages are safely in Convex.
//
// Polled rather than watched, like the context tracker: a stat per session per
// second costs nothing when the file hasn't moved, and message cadence is
// seconds, so nothing is gained by reacting faster.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { claudeProjectDir, findClaudeTranscript } from './agent-context'
import { buildQuestionMessage, parseClaudeLine, parseCodexLine, type ChatMessage } from './agent-message-model'
import { ChunkSeq } from './remote-bridge-seq'
import type { TrackedAgentSession } from './agent-context-tracker'

/** A ChatMessage with its allocated position in the session's message stream. */
export type OutgoingChatMessage = ChatMessage & { seq: number }

/** How often each tracked transcript is stat-ed for growth. */
const DEFAULT_POLL_MS = 1_000

/**
 * How long a claude entry waits for a hook-reported transcript before falling
 * back to the cwd guess. A fresh session has no transcript yet, so an
 * immediate guess attaches the newest file in the project dir — some OTHER
 * conversation — and the phone renders a foreign chat until the swap-clear
 * sweeps it. SessionStart reports the real path within a couple of seconds of
 * launch; the fallback still runs afterwards for sessions whose hooks stay
 * silent (desktop restart over an idle conversation, hookless installs).
 */
const DEFAULT_CLAUDE_GUESS_GRACE_MS = 5_000

/** Minimum spacing between appendMessages calls per session (see flush). */
const DEFAULT_FLUSH_GAP_MS = 750

/** appendMessages batch ceiling — the backend contract callers must honor. */
const MAX_BATCH = 40

/** Bytes read off the end of a transcript on first attach. */
const BACKFILL_BYTES = 512 * 1024

/** How much history a first attach seeds. The chat view is a scrollback
 *  window, not an archive — 80 messages is several phone screens. */
const BACKFILL_MESSAGES = 80

/**
 * Ceiling on unsent messages held per session. The backend caps a session at
 * 400 rows and evicts from the head, so buffering more than that during a
 * Convex outage would only produce messages the server immediately deletes —
 * drop the oldest locally instead and keep memory bounded.
 */
const BUFFER_CAP = 400

/** A buffered message; seq is stamped when it first enters a batch, and kept
 *  across retries so a failed send re-sends the same identity at the same
 *  position (uid + seq dedupe upstream). */
type Buffered = ChatMessage & { seq?: number }

export interface AgentMessageMirrorOptions {
  /**
   * The rollout file the codex watcher has attached to this session, if any.
   * Codex's path is resolved exactly (via lsof) over there; re-deriving it here
   * would mean re-implementing that resolution and its sub-worker vetoes.
   */
  resolveCodexTranscript: (sessionId: string) => string | null
  /** appendMessages, device-authed; injected so tests never touch Convex. */
  sendAppend: (sessionId: string, messages: OutgoingChatMessage[]) => Promise<unknown>
  /** messagesHeadSeq: highest stored seq for the session, or -1 if none. */
  fetchHeadSeq: (sessionId: string) => Promise<number>
  /** clearMessages: drop the session's conversation (session untracked). */
  clearSession: (sessionId: string) => Promise<unknown>
  pollIntervalMs?: number
  /** Spacing floor between sends per session; tests shrink it. */
  flushGapMs?: number
  /** Hook-wait before the claude cwd fallback may fire; tests shrink it. */
  claudeGuessGraceMs?: number
  home?: string
}

interface Entry {
  agent: 'claude' | 'codex'
  cwd: string
  /** When this entry entered tracking — the clock the guess grace runs on. */
  trackedAt: number
  /** Resolved transcript, once we've found one. */
  file: string | null
  /** Path handed to us by a claude hook — authoritative, never re-guessed. */
  hookFile: string | null
  /** The file the tail state below belongs to (null = not attached yet). */
  tailPath: string | null
  /** Inode of tailPath at attach, so an in-place rotation (same path, new
   *  file) is caught even when the replacement is larger than our offset. */
  ino: number | null
  /** Bytes of tailPath consumed so far. */
  offset: number
  /** 1-based line number of the last complete line consumed. Only codex uids
   *  depend on it being the file-absolute number (see attach). */
  lineNo: number
  /** Trailing partial line carried between reads. Kept as bytes, not string:
   *  a UTF-8 character split across two reads must not be decoded torn. */
  pending: Buffer
  /** Parsed messages not yet confirmed stored in Convex. */
  buffer: Buffered[]
  /** A flush for this session is in flight — poll ticks must not stack. */
  flushing: boolean
  /** When the last send was attempted (attempt, not success: failures pace
   *  their retries on the same clock). */
  lastSendAt: number
  /** A send/prime failure has been logged; reset on success so a new outage
   *  logs once instead of once per tick. */
  loggedSendError: boolean
}

function newEntry(agent: 'claude' | 'codex', cwd: string): Entry {
  return {
    agent,
    cwd,
    trackedAt: Date.now(),
    file: null,
    hookFile: null,
    tailPath: null,
    ino: null,
    offset: 0,
    lineNo: 0,
    pending: Buffer.alloc(0),
    buffer: [],
    flushing: false,
    lastSendAt: 0,
    loggedSendError: false,
  }
}

/** Split a byte buffer into complete lines (decoded) plus the trailing
 *  partial-line remainder (kept as bytes). The remainder is copied so the
 *  potentially large read buffer can be collected. */
function splitLines(buf: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = []
  let start = 0
  for (;;) {
    const nl = buf.indexOf(0x0a, start)
    if (nl === -1) break
    lines.push(buf.subarray(start, nl).toString('utf8'))
    start = nl + 1
  }
  return { lines, rest: Buffer.from(buf.subarray(start)) }
}

/** One dispatch point for the two transcript dialects. lineNo and fileBase
 *  only matter to codex, whose record identity is positional (see
 *  parseCodexLine); claude records carry their own uuid. */
function parseTranscriptLine(
  agent: 'claude' | 'codex',
  line: string,
  lineNo: number,
  fileBase: string,
): ChatMessage[] {
  return agent === 'claude' ? parseClaudeLine(line) : parseCodexLine(line, lineNo, fileBase)
}

/** Newlines in the first `limit` bytes of an open file — how many complete
 *  lines precede a mid-file attach window. */
function countNewlines(fd: number, limit: number): number {
  const chunk = Buffer.allocUnsafe(Math.min(limit, 256 * 1024))
  let count = 0
  let offset = 0
  while (offset < limit) {
    const bytes = fs.readSync(fd, chunk, 0, Math.min(chunk.length, limit - offset), offset)
    if (bytes <= 0) break
    for (let i = 0; i < bytes; i++) {
      if (chunk[i] === 0x0a) count++
    }
    offset += bytes
  }
  return count
}

export class AgentMessageMirror {
  private readonly opts: AgentMessageMirrorOptions
  private readonly entries = new Map<string, Entry>()
  private readonly home: string
  private readonly flushGapMs: number
  private readonly claudeGuessGraceMs: number
  private readonly timer: ReturnType<typeof setInterval>
  private soon: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  // Same invariant as the PTY ChunkSeq: monotonic per session for the lifetime
  // of this mirror, primed once (above both Convex's head and the wall clock —
  // see flush), NEVER reset — a reset would land fresh messages at seqs a
  // still-subscribed web cursor has already passed, freezing its chat forever.
  // Kept outside the entries map so an untrack/retrack of the same session
  // keeps climbing.
  private readonly seq = new ChunkSeq()

  constructor(opts: AgentMessageMirrorOptions) {
    this.opts = opts
    this.home = opts.home ?? os.homedir()
    this.flushGapMs = opts.flushGapMs ?? DEFAULT_FLUSH_GAP_MS
    this.claudeGuessGraceMs = opts.claudeGuessGraceMs ?? DEFAULT_CLAUDE_GUESS_GRACE_MS
    const interval = Math.max(25, opts.pollIntervalMs ?? DEFAULT_POLL_MS)
    this.timer = setInterval(() => this.poll(), interval)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /**
   * Attach the newcomers without waiting for the next tick — a session opened
   * on the phone should show its conversation immediately, not up to a poll
   * later. Deferred and coalesced rather than run inline: setSessions is called
   * from the middle of the mirror push, and file reads have no business
   * happening there.
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
   * A session that dropped off (closed, or the agent exited) has its stored
   * conversation cleared — the phone must not render a chat for a session that
   * no longer exists — and its local state forgotten. Its seq counter survives
   * on purpose (see `seq`).
   */
  setSessions(sessions: TrackedAgentSession[]): void {
    const live = new Set<string>()
    for (const s of sessions) {
      live.add(s.sessionId)
      const existing = this.entries.get(s.sessionId)
      // An agent swap in the same pane (claude → codex) invalidates the
      // transcript we resolved, but not the session itself.
      if (existing && existing.agent === s.agent && existing.cwd === s.cwd) continue
      this.entries.set(s.sessionId, newEntry(s.agent, s.cwd))
    }
    for (const id of [...this.entries.keys()]) {
      if (live.has(id)) continue
      this.entries.delete(id)
      void Promise.resolve(this.opts.clearSession(id)).catch((err: unknown) => {
        console.error('[message-mirror] clearMessages failed', id, err)
      })
    }
    if (sessions.some((s) => this.entries.get(s.sessionId)?.tailPath == null)) {
      this.pollSoon()
    }
  }

  /**
   * A claude hook told us the transcript for this session. Authoritative — it
   * replaces whatever the cwd fallback guessed; if that changes the path, the
   * next poll treats it as a conversation swap (see noteSwap) and re-seeds
   * from the reported file.
   */
  noteClaudeTranscript(sessionId: string, transcriptPath: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.agent !== 'claude') return
    const resolved = path.resolve(transcriptPath)
    if (entry.hookFile === resolved) return
    entry.hookFile = resolved
    entry.file = resolved
    this.pollSoon()
  }

  /**
   * A PreToolUse hook reported that this session just opened an AskUserQuestion
   * form. Mirror it NOW rather than waiting for the transcript to carry it.
   *
   * Why this path exists at all: the phone's card is only answerable while the
   * form is still the conversation's last unanswered item, and the transcript
   * copy is not reliably early enough — measured on a live form, the question
   * reached Convex 24s after it opened and 0.5s AFTER the desktop answer, so
   * the card was already resolved (and therefore static) on arrival. The hook
   * fires when the form opens, which is the only signal with the right timing.
   *
   * The transcript copy still arrives later and upserts onto this row by uid
   * (see questionUid), which is what attaches the answer and retires the card.
   * A form that is never answered leaves this row as the tail of the
   * conversation, exactly as the desktop shows it.
   */
  noteClaudeQuestion(sessionId: string, toolUseId: string, toolInput: unknown): void {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.agent !== 'claude') return
    const message = buildQuestionMessage(toolUseId, toolInput, Date.now())
    if (!message) return
    this.enqueue(entry, [message])
    // Don't wait up to a poll for a form the user is looking at right now.
    void this.flush(sessionId, entry)
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    this.soon = null
    this.entries.clear()
  }

  private poll(): void {
    for (const [sessionId, entry] of this.entries) {
      this.tail(sessionId, entry)
      void this.flush(sessionId, entry)
    }
  }

  /** Advance one session's tail: re-resolve the path, catch rotations, read
   *  growth. All synchronous fs — the async half is flush(). */
  private tail(sessionId: string, entry: Entry): void {
    const file = this.resolveFile(sessionId, entry)
    if (!file) return
    // A different file than the one being tailed is a different conversation —
    // claude writes one JSONL per conversation, and the codex watcher swaps
    // rollout files the same way. The rows already pushed describe a
    // conversation this session no longer shows (most commonly a fresh agent
    // session whose pre-hook cwd guess was the previous conversation), so they
    // must go. A same-path re-attach (resume rewrote the file in place, or a
    // truncation) stays a plain re-seed below: same conversation, uid dedupe
    // absorbs the overlap.
    if (entry.tailPath !== null && entry.tailPath !== file) this.noteSwap(sessionId, entry, file)
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      // The transcript vanished (worktree deleted, history cleared). Drop the
      // resolution so the next tick can find a replacement; a hook-reported
      // path stays pinned and simply waits for the file to come back.
      entry.file = entry.hookFile
      return
    }
    // Same file we're attached to, not truncated: only growth to consume. A
    // path change, a swapped inode (resume rewrote the file in place), or a
    // shrink all mean the tail state describes a file that no longer exists —
    // re-run the first attach; the seq counter is untouched by design.
    const attached = entry.tailPath === file && entry.ino === stat.ino && stat.size >= entry.offset
    if (!attached) {
      this.attach(entry, file)
      return
    }
    if (stat.size > entry.offset) this.readGrowth(entry, file)
  }

  /**
   * The session's transcript swapped to a different file: clear the stored
   * conversation server-side, drop everything buffered locally (a batch a
   * failed send is retrying would resurrect the old conversation), and put a
   * reset marker in-band so a mounted ChatPane — which holds its own copy of
   * the rows it rendered, beyond the reach of the server-side delete — knows
   * to discard them. The marker rides the normal append stream, so it is
   * ordered after the clear (one Convex client, one websocket, mutations in
   * dispatch order) and before the new file's backfill (enqueued behind it
   * here). Its uid derives from the new file so retries dedupe instead of
   * stacking markers. The seq counter is untouched, as everywhere.
   */
  private noteSwap(sessionId: string, entry: Entry, file: string): void {
    entry.buffer = []
    // Forget the old tail so a swap whose new file doesn't exist yet (a hook
    // can report the path before claude writes it) doesn't re-fire every tick.
    entry.tailPath = null
    void Promise.resolve(this.opts.clearSession(sessionId)).catch((err: unknown) => {
      console.error('[message-mirror] clearMessages failed', sessionId, err)
    })
    this.enqueue(entry, [
      {
        uid: `reset:${path.basename(file, '.jsonl')}`,
        role: 'system',
        blocks: [{ kind: 'reset' }],
        ts: Date.now(),
      },
    ])
  }

  /**
   * First attach to a transcript (also rotation/path-swap recovery): read at
   * most the last BACKFILL_BYTES, drop the leading partial line the window cut
   * through, parse everything, and seed the buffer with the last
   * BACKFILL_MESSAGES messages.
   *
   * Codex uids are `<fileBase>:<lineNo>` with lineNo absolute in the file, so
   * when the window starts mid-file the lines before it have to be counted —
   * otherwise a tailer restart would mint different uids for the same records
   * and the conversation would duplicate. Claude uids are record uuids, so the
   * count (a full-file scan) is skipped for it.
   */
  private attach(entry: Entry, file: string): void {
    let fd: number
    try {
      fd = fs.openSync(file, 'r')
    } catch {
      entry.file = entry.hookFile
      return
    }
    let lines: string[]
    let lineBase: number
    try {
      const stat = fs.fstatSync(fd)
      const start = Math.max(0, stat.size - BACKFILL_BYTES)
      const preceding = start > 0 && entry.agent === 'codex' ? countNewlines(fd, start) : 0
      const buf = Buffer.allocUnsafe(stat.size - start)
      if (buf.length > 0) fs.readSync(fd, buf, 0, buf.length, start)
      const split = splitLines(buf)
      lines = split.lines
      // The window almost always opens mid-line; the fragment completes line
      // `preceding + 1` whose head we never saw, so it can't be parsed.
      lineBase = preceding
      if (start > 0) {
        lines.shift()
        lineBase += 1
      }
      entry.tailPath = file
      entry.ino = stat.ino
      entry.offset = stat.size
      entry.pending = split.rest
      entry.lineNo = lineBase + lines.length
    } catch {
      // Read raced a rotation; leave the entry unattached and retry next tick.
      entry.tailPath = null
      return
    } finally {
      try {
        fs.closeSync(fd)
      } catch {}
    }
    const messages: ChatMessage[] = []
    const fileBase = path.basename(file, '.jsonl')
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseTranscriptLine(entry.agent, lines[i], lineBase + 1 + i, fileBase)
      for (const m of parsed) messages.push(m)
    }
    this.enqueue(entry, messages.slice(-BACKFILL_MESSAGES))
  }

  /** Read the bytes appended since the last consume, carrying the partial line
   *  across reads, and parse each newly completed line. */
  private readGrowth(entry: Entry, file: string): void {
    let chunk: Buffer
    try {
      const fd = fs.openSync(file, 'r')
      try {
        const size = fs.fstatSync(fd).size
        if (size <= entry.offset) return
        chunk = Buffer.allocUnsafe(size - entry.offset)
        fs.readSync(fd, chunk, 0, chunk.length, entry.offset)
        entry.offset = size
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return
    }
    const combined = entry.pending.length > 0 ? Buffer.concat([entry.pending, chunk]) : chunk
    const { lines, rest } = splitLines(combined)
    entry.pending = rest
    if (lines.length === 0) return
    const messages: ChatMessage[] = []
    const fileBase = path.basename(file, '.jsonl')
    for (const line of lines) {
      entry.lineNo += 1
      const parsed = parseTranscriptLine(entry.agent, line, entry.lineNo, fileBase)
      for (const m of parsed) messages.push(m)
    }
    this.enqueue(entry, messages)
  }

  private enqueue(entry: Entry, messages: ChatMessage[]): void {
    if (messages.length === 0) return
    for (const m of messages) entry.buffer.push(m)
    if (entry.buffer.length > BUFFER_CAP) {
      entry.buffer.splice(0, entry.buffer.length - BUFFER_CAP)
    }
  }

  /**
   * Push one batch of buffered messages to Convex: ≤ MAX_BATCH per call,
   * ≥ flushGapMs apart per session. The buffer is the notion of "consumed" —
   * a batch leaves it only after sendAppend resolves, so a failure keeps the
   * messages (with the seqs they were stamped with) and the next tick retries
   * the identical batch. Seqs are primed lazily from the persisted head on the
   * session's first send, exactly like ChunkSeq for PTY chunks.
   */
  private async flush(sessionId: string, entry: Entry): Promise<void> {
    if (this.stopped || entry.flushing) return
    if (entry.buffer.length === 0) return
    if (Date.now() - entry.lastSendAt < this.flushGapMs) return
    entry.flushing = true
    try {
      if (!this.seq.has(sessionId)) {
        let head: number
        try {
          head = await this.opts.fetchHeadSeq(sessionId)
        } catch (err) {
          this.logOnce(entry, sessionId, 'messagesHeadSeq failed', err)
          return
        }
        // The session may have been untracked while we awaited; a dead entry
        // must not prime a counter or send anything.
        if (this.entries.get(sessionId) !== entry) return
        // Prime above BOTH the persisted head and the wall clock, not the head
        // alone. Untracking clears the stored rows, and the same terminal
        // sessionId re-enters tracking when an agent respawns in that PTY — so
        // after a desktop restart (the in-process counter gone) the head is
        // back at -1 and a head-only prime would restart seq at 0. A
        // still-mounted web ChatPane keeps the high afterSeq cursor from the
        // previous conversation, and its seq-greater-than query would never
        // match again: the chat freezes forever. Anchoring the cold prime to
        // the clock lands it above every seq any earlier conversation handed
        // out, because earlier primes were epoch-anchored the same way and
        // time only moves forward.
        const persisted = typeof head === 'number' && Number.isFinite(head) ? head : -1
        this.seq.init(sessionId, Math.max(persisted + 1, Date.now()) - 1)
      }
      const batch = entry.buffer.slice(0, MAX_BATCH)
      for (const m of batch) {
        if (m.seq === undefined) m.seq = this.seq.next(sessionId)
      }
      // Last liveness check before the append leaves this process. An untrack
      // during any suspension above has already dispatched clearMessages, and
      // a batch committed after that clear would resurrect rows for a session
      // the phone no longer lists — until the TTL sweep, days later. Once the
      // dispatch below happens first there is no window left: Convex executes
      // one client's mutations in order over its single websocket, so an
      // append dispatched before the untrack lands before the clear.
      if (this.entries.get(sessionId) !== entry) return
      entry.lastSendAt = Date.now()
      try {
        await this.opts.sendAppend(sessionId, batch as OutgoingChatMessage[])
      } catch (err) {
        this.logOnce(entry, sessionId, 'appendMessages failed', err)
        return
      }
      entry.loggedSendError = false
      // Remove by identity, not by count: the buffer cap may have evicted part
      // of the batch from the head while the send was in flight.
      const sent = new Set<Buffered>(batch)
      entry.buffer = entry.buffer.filter((m) => !sent.has(m))
    } finally {
      entry.flushing = false
    }
  }

  private logOnce(entry: Entry, sessionId: string, what: string, err: unknown): void {
    if (entry.loggedSendError) return
    entry.loggedSendError = true
    console.error(`[message-mirror] ${what} for ${sessionId} — will retry`, err)
  }

  /** Which transcript this session should be tailing right now. Mirrors the
   *  context tracker's resolution: hook path wins, codex is re-asked every
   *  tick (the watcher re-attaches on rollout swaps), claude falls back to the
   *  newest unclaimed transcript in the cwd's project directory. */
  private resolveFile(sessionId: string, entry: Entry): string | null {
    if (entry.hookFile) return entry.hookFile
    if (entry.agent === 'codex') {
      const file = this.opts.resolveCodexTranscript(sessionId)
      if (file) entry.file = file
      return entry.file
    }
    if (entry.file) return entry.file
    // Give SessionStart its window before guessing (see the grace constant).
    if (Date.now() - entry.trackedAt < this.claudeGuessGraceMs) return null
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
    entry.file = findClaudeTranscript(
      dir,
      names,
      (name) => {
        try {
          return fs.statSync(path.join(dir, name)).mtimeMs
        } catch {
          return null
        }
      },
      claimedPaths,
    )
    return entry.file
  }
}
