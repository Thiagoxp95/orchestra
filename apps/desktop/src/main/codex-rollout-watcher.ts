// Tails codex's official rollout JSONL files (`~/.codex/sessions/YYYY/MM/DD/
// rollout-<ts>-<sessionId>.jsonl`) and emits structured working/idle events
// from the canonical `event_msg` payloads codex writes for every turn.
//
// This is the deterministic replacement for the old TUI-banner regex and
// codex-hook Stop deferral: codex itself records `task_started` / `task_complete`
// / `turn_aborted` / `error` to disk during the turn, so we don't have to
// guess from terminal output or hook timing.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type CodexRolloutState = 'working' | 'idle'

export interface CodexRolloutEvent {
  state: CodexRolloutState
  turnId?: string
  lastAgentMessage?: string
  aborted?: boolean
  error?: string
}

export interface CodexRolloutWatcherOptions {
  onEvent: (sessionId: string, event: CodexRolloutEvent) => void
  /** Polling interval for `fs.watchFile`. Defaults to 200ms (good for prod). */
  pollIntervalMs?: number
}

// codex's protocol v1 uses `task_started` / `task_complete`; v2 uses
// `turn_started` / `turn_complete` (the rust enum aliases both). We accept
// both so we don't drift if codex flips its on-the-wire name.
const TASK_STARTED_TYPES = new Set(['task_started', 'turn_started'])
const TASK_COMPLETE_TYPES = new Set(['task_complete', 'turn_complete'])
const RELEVANT_EVENT_MSG_TYPES = new Set([
  ...TASK_STARTED_TYPES,
  ...TASK_COMPLETE_TYPES,
  'turn_aborted',
  'error',
  'stream_error',
])

export function parseRolloutLine(line: string): CodexRolloutEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as { type?: unknown; payload?: unknown }
  if (obj.type !== 'event_msg' || !obj.payload || typeof obj.payload !== 'object') return null
  const payload = obj.payload as { type?: unknown; turn_id?: unknown; last_agent_message?: unknown; message?: unknown }
  const eventType = typeof payload.type === 'string' ? payload.type : null
  if (!eventType || !RELEVANT_EVENT_MSG_TYPES.has(eventType)) return null

  const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : undefined

  if (TASK_STARTED_TYPES.has(eventType)) {
    return turnId ? { state: 'working', turnId } : { state: 'working' }
  }
  if (TASK_COMPLETE_TYPES.has(eventType)) {
    const message = typeof payload.last_agent_message === 'string' && payload.last_agent_message.length > 0
      ? payload.last_agent_message
      : undefined
    const event: CodexRolloutEvent = { state: 'idle' }
    if (turnId) event.turnId = turnId
    if (message) event.lastAgentMessage = message
    return event
  }
  switch (eventType) {
    case 'turn_aborted': {
      const event: CodexRolloutEvent = { state: 'idle', aborted: true }
      if (turnId) event.turnId = turnId
      return event
    }
    case 'error':
    case 'stream_error': {
      const message = typeof payload.message === 'string' ? payload.message : undefined
      const event: CodexRolloutEvent = { state: 'idle' }
      if (message) event.error = message
      return event
    }
    default:
      return null
  }
}

export interface CodexRolloutWatcherDebugEntry {
  orchestraSessionId: string
  transcriptPath: string
  lastState: CodexRolloutState | null
  lastTurnId: string | null
  lastEventAt: number | null
  fileExists: boolean
  bytesRead: number
}

class SessionTail {
  private bytesRead = 0
  private buffer = ''
  private readonly file: string
  private readonly sessionId: string
  private readonly onEvent: (sessionId: string, event: CodexRolloutEvent) => void
  private readonly pollIntervalMs: number
  private watching = false
  private stopped = false
  private lastState: CodexRolloutState | null = null
  private lastTurnId: string | null = null
  private lastEventAt: number | null = null

  constructor(
    sessionId: string,
    file: string,
    onEvent: (sessionId: string, event: CodexRolloutEvent) => void,
    pollIntervalMs: number,
  ) {
    this.sessionId = sessionId
    this.file = file
    this.onEvent = onEvent
    this.pollIntervalMs = pollIntervalMs
  }

  describe(): CodexRolloutWatcherDebugEntry {
    let fileExists = false
    try { fileExists = fs.existsSync(this.file) } catch {}
    return {
      orchestraSessionId: this.sessionId,
      transcriptPath: this.file,
      lastState: this.lastState,
      lastTurnId: this.lastTurnId,
      lastEventAt: this.lastEventAt,
      fileExists,
      bytesRead: this.bytesRead,
    }
  }

  start(): void {
    // Initial scan: if the file already exists, replay only the *latest*
    // relevant event so the consumer learns the current state without re-living
    // the whole turn history.
    this.scanInitial()
    this.beginWatching()
  }

  stop(): void {
    this.stopped = true
    if (this.watching) {
      try { fs.unwatchFile(this.file) } catch {}
      this.watching = false
    }
  }

  private scanInitial(): void {
    let stat: fs.Stats
    try {
      stat = fs.statSync(this.file)
    } catch {
      // File doesn't exist yet — beginWatching will pick it up when it does.
      return
    }
    let content: string
    try {
      content = fs.readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    this.bytesRead = stat.size
    // Find the most recent relevant event by scanning lines bottom-up.
    const lines = content.split('\n')
    let latest: CodexRolloutEvent | null = null
    for (let i = lines.length - 1; i >= 0; i--) {
      const event = parseRolloutLine(lines[i] ?? '')
      if (event) {
        latest = event
        break
      }
    }
    if (latest) {
      this.recordEvent(latest)
      this.onEvent(this.sessionId, latest)
    }
  }

  private recordEvent(event: CodexRolloutEvent): void {
    this.lastState = event.state
    this.lastTurnId = event.turnId ?? this.lastTurnId
    this.lastEventAt = Date.now()
  }

  private beginWatching(): void {
    if (this.watching || this.stopped) return
    this.watching = true
    fs.watchFile(this.file, { interval: this.pollIntervalMs, persistent: false }, (curr) => {
      if (this.stopped) return
      // Truncation/rotation guard — codex doesn't rotate within a session, but
      // resuming a session can re-open the file. Reset and rescan from start.
      if (curr.size < this.bytesRead) {
        this.bytesRead = 0
        this.buffer = ''
      }
      if (curr.size <= this.bytesRead) return
      this.readAppended(curr.size)
    })
  }

  private readAppended(newSize: number): void {
    let chunk: string
    try {
      const fd = fs.openSync(this.file, 'r')
      try {
        const length = newSize - this.bytesRead
        const buf = Buffer.allocUnsafe(length)
        fs.readSync(fd, buf, 0, length, this.bytesRead)
        chunk = buf.toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return
    }
    this.bytesRead = newSize
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    // Last entry is the partial line (no trailing newline yet) — keep it
    // buffered for the next read.
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      const event = parseRolloutLine(line)
      if (!event) continue
      this.recordEvent(event)
      this.onEvent(this.sessionId, event)
    }
  }
}

export class CodexRolloutWatcher {
  private readonly opts: CodexRolloutWatcherOptions
  private readonly tails = new Map<string, SessionTail>()
  private readonly pollIntervalMs: number
  private readonly sessionsRoot: string

  constructor(opts: CodexRolloutWatcherOptions & { sessionsRoot?: string } = { onEvent: () => {} }) {
    this.opts = opts
    this.pollIntervalMs = Math.max(25, opts.pollIntervalMs ?? 200)
    this.sessionsRoot = opts.sessionsRoot ?? path.join(os.homedir(), '.codex', 'sessions')
  }

  watchSession(sessionId: string, transcriptPath: string): void {
    const resolved = path.resolve(transcriptPath)
    const existing = this.tails.get(sessionId)
    if (existing) {
      // Same path — no-op. Different path — switch over.
      if (existing.describe().transcriptPath === resolved) return
      existing.stop()
    }
    console.log(`[codex-rollout] attach session=${sessionId.slice(0, 8)} file=${resolved}`)
    const tail = new SessionTail(sessionId, resolved, this.opts.onEvent, this.pollIntervalMs)
    this.tails.set(sessionId, tail)
    tail.start()
  }

  /**
   * Last-resort discovery: when we know an orchestra session is running codex
   * but never received a hook with `transcript_path` (legacy sessions started
   * under v1.10.x, or the SessionStart hook hasn't reloaded yet), try to find
   * its rollout file by matching `cwd` against `~/.codex/sessions/.../*.jsonl`
   * and picking the most recently modified candidate that isn't already
   * watched by another orchestra session.
   *
   * Returns true if a rollout was discovered and watched.
   */
  discoverAndWatchByCwd(sessionId: string, cwd: string): boolean {
    if (this.tails.has(sessionId)) return false
    const claimed = new Set<string>()
    for (const tail of this.tails.values()) claimed.add(tail.describe().transcriptPath)
    const candidate = findMostRecentRolloutForCwd(this.sessionsRoot, cwd, claimed)
    if (!candidate) return false
    console.log(`[codex-rollout] discovered session=${sessionId.slice(0, 8)} cwd=${cwd} file=${candidate}`)
    this.watchSession(sessionId, candidate)
    return true
  }

  unwatchSession(sessionId: string): void {
    const tail = this.tails.get(sessionId)
    if (tail) {
      console.log(`[codex-rollout] detach session=${sessionId.slice(0, 8)}`)
      tail.stop()
      this.tails.delete(sessionId)
    }
  }

  /** Snapshot of every watched session for the diagnostic IPC. */
  getDebugState(): CodexRolloutWatcherDebugEntry[] {
    return Array.from(this.tails.values()).map((tail) => tail.describe())
  }

  stop(): void {
    for (const tail of this.tails.values()) tail.stop()
    this.tails.clear()
  }
}

function findMostRecentRolloutForCwd(
  sessionsRoot: string,
  cwd: string,
  exclude: ReadonlySet<string>,
): string | null {
  // Walk only the most recent date directories — codex organizes rollouts by
  // YYYY/MM/DD, so checking today + yesterday's worth is plenty for "the
  // session that just spawned" without scanning the entire history.
  const dirs = collectRecentDateDirs(sessionsRoot, 2)
  let best: { file: string; mtime: number } | null = null
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.startsWith('rollout-') || !entry.endsWith('.jsonl')) continue
      const full = path.join(dir, entry)
      if (exclude.has(full)) continue
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { continue }
      if (best && stat.mtimeMs < best.mtime) continue
      if (!sessionMetaCwdMatches(full, cwd)) continue
      best = { file: full, mtime: stat.mtimeMs }
    }
  }
  return best?.file ?? null
}

function collectRecentDateDirs(sessionsRoot: string, days: number): string[] {
  // Returns the N most-recent YYYY/MM/DD directories that exist. We discover
  // them by listing the root rather than computing dates so daylight-saving
  // / clock-skew doesn't matter.
  const out: { dir: string; key: string }[] = []
  let years: string[]
  try { years = fs.readdirSync(sessionsRoot) } catch { return [] }
  years.sort().reverse()
  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue
    let months: string[]
    try { months = fs.readdirSync(path.join(sessionsRoot, year)) } catch { continue }
    months.sort().reverse()
    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue
      let dayEntries: string[]
      try { dayEntries = fs.readdirSync(path.join(sessionsRoot, year, month)) } catch { continue }
      dayEntries.sort().reverse()
      for (const day of dayEntries) {
        if (!/^\d{2}$/.test(day)) continue
        out.push({ dir: path.join(sessionsRoot, year, month, day), key: `${year}${month}${day}` })
        if (out.length >= days) return out.map((entry) => entry.dir)
      }
    }
  }
  return out.map((entry) => entry.dir)
}

function sessionMetaCwdMatches(file: string, cwd: string): boolean {
  // session_meta is always the first line of a rollout. We read just enough
  // bytes to parse it instead of slurping the whole file (some rollouts get
  // large during long sessions).
  let fd: number
  try { fd = fs.openSync(file, 'r') } catch { return false }
  try {
    const buf = Buffer.allocUnsafe(8 * 1024)
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0)
    const head = buf.slice(0, bytes).toString('utf8')
    const newline = head.indexOf('\n')
    const firstLine = newline === -1 ? head : head.slice(0, newline)
    if (!firstLine) return false
    const parsed = JSON.parse(firstLine) as { type?: unknown; payload?: { cwd?: unknown } }
    if (parsed.type !== 'session_meta') return false
    return typeof parsed.payload?.cwd === 'string' && parsed.payload.cwd === cwd
  } catch {
    return false
  } finally {
    try { fs.closeSync(fd) } catch {}
  }
}
