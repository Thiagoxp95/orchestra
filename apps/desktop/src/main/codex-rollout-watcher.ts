// Tails codex's official rollout JSONL files (`~/.codex/sessions/YYYY/MM/DD/
// rollout-<ts>-<sessionId>.jsonl`) and emits structured working/idle events
// from the canonical `event_msg` payloads codex writes for every turn.
//
// This is the deterministic replacement for the old TUI-banner regex and
// codex-hook Stop deferral: codex itself records `task_started` / `task_complete`
// / `turn_aborted` / `error` to disk during the turn, so we don't have to
// guess from terminal output or hook timing.

import * as fs from 'node:fs'
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

const RELEVANT_EVENT_MSG_TYPES = new Set([
  'task_started',
  'task_complete',
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

  switch (eventType) {
    case 'task_started':
      return turnId ? { state: 'working', turnId } : { state: 'working' }
    case 'task_complete': {
      const message = typeof payload.last_agent_message === 'string' && payload.last_agent_message.length > 0
        ? payload.last_agent_message
        : undefined
      const event: CodexRolloutEvent = { state: 'idle' }
      if (turnId) event.turnId = turnId
      if (message) event.lastAgentMessage = message
      return event
    }
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

class SessionTail {
  private bytesRead = 0
  private buffer = ''
  private readonly file: string
  private readonly sessionId: string
  private readonly onEvent: (sessionId: string, event: CodexRolloutEvent) => void
  private readonly pollIntervalMs: number
  private watching = false
  private stopped = false

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
      this.onEvent(this.sessionId, latest)
    }
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
      if (event) this.onEvent(this.sessionId, event)
    }
  }
}

export class CodexRolloutWatcher {
  private readonly opts: CodexRolloutWatcherOptions
  private readonly tails = new Map<string, SessionTail>()
  private readonly pollIntervalMs: number

  constructor(opts: CodexRolloutWatcherOptions) {
    this.opts = opts
    this.pollIntervalMs = Math.max(25, opts.pollIntervalMs ?? 200)
  }

  watchSession(sessionId: string, transcriptPath: string): void {
    const resolved = path.resolve(transcriptPath)
    const existing = this.tails.get(sessionId)
    if (existing) existing.stop()
    const tail = new SessionTail(sessionId, resolved, this.opts.onEvent, this.pollIntervalMs)
    this.tails.set(sessionId, tail)
    tail.start()
  }

  unwatchSession(sessionId: string): void {
    const tail = this.tails.get(sessionId)
    if (tail) {
      tail.stop()
      this.tails.delete(sessionId)
    }
  }

  stop(): void {
    for (const tail of this.tails.values()) tail.stop()
    this.tails.clear()
  }
}
