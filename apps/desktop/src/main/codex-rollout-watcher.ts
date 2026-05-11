// Tails codex's official rollout JSONL files (`~/.codex/sessions/YYYY/MM/DD/
// rollout-<ts>-<sessionId>.jsonl`) and emits structured working/idle events
// from the canonical `event_msg` payloads codex writes for every turn.
//
// This is the deterministic replacement for the old TUI-banner regex and
// codex-hook Stop deferral: codex itself records `task_started` / `task_complete`
// / `turn_aborted` / `error` to disk during the turn, so we don't have to
// guess from terminal output or hook timing.

import { execFileSync } from 'node:child_process'
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
  private readonly discoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Discovery retry schedule. Codex CLI doesn't write session_meta until
  // *after* the process is detectable — observed gap was 60s on a heavily
  // loaded machine. Phase 1 is a tight burst that wins the common race
  // (file appears within a few seconds); phase 2 polls every 30s
  // indefinitely so we still attach when codex takes minutes to
  // materialize. Discovery only stops when the watcher attaches or
  // unwatchSession is called (e.g. session leaves codex status).
  private static readonly DISCOVERY_FAST_DELAYS_MS = [500, 1000, 2000, 4000, 8000]
  private static readonly DISCOVERY_SLOW_INTERVAL_MS = 30_000

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
   * Last-resort discovery: when lsof and hook-derived session_id both fail,
   * try to find the rollout by matching `cwd` against
   * `~/.codex/sessions/.../*.jsonl` and picking the most recently modified
   * candidate that isn't already watched by another orchestra session.
   *
   * Best-effort heuristic; can mispair when multiple defunct rollouts share
   * a cwd. Prefer attachByAiPid (exact) when possible.
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

  /**
   * Authoritative attach when codex's hook payload told us the session_id
   * but `transcript_path` was null (codex sets it null until the rollout is
   * materialized). The rollout filename embeds the session id, so we can
   * glob `~/.codex/sessions/YYYY/MM/DD/rollout-*-<codexSessionId>.jsonl`
   * and attach to the exact match — replacing whatever cwd-fallback may
   * have wrongly paired this orchestra session with.
   *
   * Returns true if the file was found and watched. Idempotent: re-attaching
   * the same path is a no-op.
   */
  attachByCodexSessionId(orchestraSessionId: string, codexSessionId: string): boolean {
    const file = findRolloutByCodexSessionId(this.sessionsRoot, codexSessionId)
    if (!file) return false
    const existing = this.tails.get(orchestraSessionId)
    if (existing && existing.describe().transcriptPath === path.resolve(file)) return true
    console.log(`[codex-rollout] attach-by-id session=${orchestraSessionId.slice(0, 8)} codex=${codexSessionId.slice(0, 8)} file=${file}`)
    this.watchSession(orchestraSessionId, file)
    return true
  }

  /**
   * Schedules `discoverAndWatchByCwd` immediately, then retries on an
   * exponential-backoff schedule until it succeeds or the schedule is
   * exhausted (~40s total). Codex CLI creates its rollout file a few seconds
   * after the process becomes detectable, so a single attempt loses the race
   * for fresh sessions; this fans the attempts out so we don't miss them.
   *
   * Idempotent — calling it again for the same session resets the schedule.
   */
  scheduleDiscovery(sessionId: string, cwd: string, aiPid?: number | null): void {
    this.cancelDiscovery(sessionId)
    if (this.tails.has(sessionId)) return

    // lsof is the authoritative path: it asks the kernel which rollout file
    // codex has open. When we know codex's aiPid we *only* use lsof — never
    // cwd-fallback. The cwd-fallback's "newest matching" heuristic can attach
    // to a defunct prior-session rollout, whose scanInitial then emits an
    // idle event with the previous turn's task_complete and triggers a
    // spurious "needs input" toast (the bug fixed here). lsof can transiently
    // return nothing in the window between codex spawn and file open, so we
    // retry on the schedule below until it succeeds.
    if (aiPid) {
      if (this.attachByAiPid(sessionId, aiPid)) return
      this.scheduleLsofRetries(sessionId, aiPid)
      return
    }

    // No aiPid — fall back to cwd-matching as best-effort. This path only
    // runs for sessions where process-monitor couldn't determine the codex
    // pid (rare; usually legacy sessions detected at startup before a fresh
    // process scan completes).
    if (this.discoverAndWatchByCwd(sessionId, cwd)) return
    this.scheduleCwdRetries(sessionId, cwd)
  }

  private scheduleLsofRetries(sessionId: string, aiPid: number): void {
    let attempt = 0
    const tryNext = (): void => {
      if (this.tails.has(sessionId)) {
        this.discoveryTimers.delete(sessionId)
        return
      }
      const fast = CodexRolloutWatcher.DISCOVERY_FAST_DELAYS_MS
      const delay = attempt < fast.length ? fast[attempt]! : CodexRolloutWatcher.DISCOVERY_SLOW_INTERVAL_MS
      attempt++
      const timer = setTimeout(() => {
        if (this.tails.has(sessionId)) {
          this.discoveryTimers.delete(sessionId)
          return
        }
        if (this.attachByAiPid(sessionId, aiPid)) {
          this.discoveryTimers.delete(sessionId)
          return
        }
        tryNext()
      }, delay)
      this.discoveryTimers.set(sessionId, timer)
    }
    tryNext()
  }

  private scheduleCwdRetries(sessionId: string, cwd: string): void {
    let attempt = 0
    const tryNext = (): void => {
      if (this.tails.has(sessionId)) {
        this.discoveryTimers.delete(sessionId)
        return
      }
      const fast = CodexRolloutWatcher.DISCOVERY_FAST_DELAYS_MS
      const delay = attempt < fast.length ? fast[attempt]! : CodexRolloutWatcher.DISCOVERY_SLOW_INTERVAL_MS
      attempt++
      const timer = setTimeout(() => {
        if (this.tails.has(sessionId)) {
          this.discoveryTimers.delete(sessionId)
          return
        }
        if (this.discoverAndWatchByCwd(sessionId, cwd)) {
          this.discoveryTimers.delete(sessionId)
          return
        }
        tryNext()
      }, delay)
      this.discoveryTimers.set(sessionId, timer)
    }
    tryNext()
  }

  /**
   * Authoritative attach: ask the OS which rollout file codex's process tree
   * (rooted at aiPid) has open via lsof. The codex binary always opens its
   * rollout `O_WRONLY|O_APPEND` for the duration of the session — so as long
   * as codex is running, lsof returns the exact path.
   *
   * No guesswork. No dependency on hook approval, on cwd uniqueness, on
   * filename timestamps. Replaces a wrong-attached file if the lsof path
   * differs from the current attach.
   */
  attachByAiPid(orchestraSessionId: string, aiPid: number): boolean {
    const file = findRolloutForAiPid(aiPid)
    if (!file) return false
    const existing = this.tails.get(orchestraSessionId)
    if (existing && existing.describe().transcriptPath === path.resolve(file)) return true
    console.log(`[codex-rollout] attach-by-pid session=${orchestraSessionId.slice(0, 8)} aiPid=${aiPid} file=${file}`)
    this.watchSession(orchestraSessionId, file)
    return true
  }

  private cancelDiscovery(sessionId: string): void {
    const timer = this.discoveryTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.discoveryTimers.delete(sessionId)
    }
  }

  unwatchSession(sessionId: string): void {
    this.cancelDiscovery(sessionId)
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
    for (const timer of this.discoveryTimers.values()) clearTimeout(timer)
    this.discoveryTimers.clear()
    for (const tail of this.tails.values()) tail.stop()
    this.tails.clear()
  }
}

function findRolloutByCodexSessionId(sessionsRoot: string, codexSessionId: string): string | null {
  // Codex names rollouts `rollout-<ISO-timestamp>-<sessionId>.jsonl`, so the
  // session id is a deterministic suffix. We just walk the recent date dirs
  // looking for a filename ending in `-<codexSessionId>.jsonl`. No need to
  // crack open the JSON — the filename itself is authoritative.
  const suffix = `-${codexSessionId}.jsonl`
  // Wider window than cwd-fallback because session_id-based lookup is exact;
  // if codex told us this id, the file is the right one regardless of age.
  const dirs = collectRecentDateDirs(sessionsRoot, 7)
  for (const dir of dirs) {
    let entries: string[]
    try { entries = fs.readdirSync(dir) } catch { continue }
    for (const entry of entries) {
      if (!entry.startsWith('rollout-') || !entry.endsWith(suffix)) continue
      return path.join(dir, entry)
    }
  }
  return null
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

function findRolloutForAiPid(aiPid: number): string | null {
  // Walk codex's process tree (Orchestra's `aiPid` is the node wrapper; the
  // codex binary runs as a child) and ask the OS which rollout file is open
  // for write. This is exact: codex opens its rollout O_WRONLY|O_APPEND for
  // the lifetime of the session, so lsof always returns the right path.
  // Falls back to null on any error so the caller can retry or use the
  // cwd-based heuristic.
  let pids: number[]
  try {
    pids = collectDescendantPids(aiPid, 3)
  } catch {
    return null
  }
  if (pids.length === 0) return null
  let lsofOut: string
  try {
    lsofOut = execFileSync('lsof', ['-p', pids.join(','), '-Fn'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
  for (const line of lsofOut.split('\n')) {
    if (!line.startsWith('n')) continue
    const filePath = line.slice(1)
    if (filePath.includes(`${path.sep}.codex${path.sep}sessions${path.sep}`) && filePath.endsWith('.jsonl')) {
      return filePath
    }
  }
  return null
}

function collectDescendantPids(rootPid: number, maxDepth: number): number[] {
  const out: number[] = [rootPid]
  let frontier: number[] = [rootPid]
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: number[] = []
    for (const pid of frontier) {
      let pgrepOut: string
      try {
        pgrepOut = execFileSync('pgrep', ['-P', String(pid)], {
          encoding: 'utf8',
          timeout: 500,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      } catch {
        // pgrep returns exit 1 when no children — treat as "no descendants"
        continue
      }
      for (const part of pgrepOut.trim().split('\n')) {
        const child = parseInt(part, 10)
        if (Number.isFinite(child)) {
          out.push(child)
          next.push(child)
        }
      }
    }
    frontier = next
  }
  return out
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
  // session_meta is always the first line of a rollout, but it's not small —
  // codex embeds the full agent base_instructions (system prompt) in the
  // payload, so the line routinely runs 20-30KB. Read in chunks until we hit
  // the first newline rather than guessing a buffer size; cap at 1MB so a
  // truncated/corrupt file can't make us slurp gigabytes.
  const firstLine = readFirstLine(file, 1024 * 1024)
  if (!firstLine) return false
  try {
    const parsed = JSON.parse(firstLine) as { type?: unknown; payload?: { cwd?: unknown } }
    if (parsed.type !== 'session_meta') return false
    return typeof parsed.payload?.cwd === 'string' && parsed.payload.cwd === cwd
  } catch {
    return false
  }
}

function readFirstLine(file: string, capBytes: number): string | null {
  let fd: number
  try { fd = fs.openSync(file, 'r') } catch { return null }
  try {
    const chunkSize = 64 * 1024
    const buf = Buffer.allocUnsafe(chunkSize)
    let combined = ''
    let offset = 0
    while (offset < capBytes) {
      const bytes = fs.readSync(fd, buf, 0, chunkSize, offset)
      if (bytes === 0) return combined.length > 0 ? combined : null
      combined += buf.slice(0, bytes).toString('utf8')
      const nl = combined.indexOf('\n')
      if (nl !== -1) return combined.slice(0, nl)
      offset += bytes
    }
    return null
  } catch {
    return null
  } finally {
    try { fs.closeSync(fd) } catch {}
  }
}
