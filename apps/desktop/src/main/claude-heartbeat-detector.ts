// Transcript-gated end-of-turn detector. Claude Code's real Stop hook
// sometimes fires late or not at all, so we arm a debounce timer whenever
// a session enters `working`. When the timer fires we do NOT blindly emit
// a synthetic Stop — that was the old behaviour and it mis-classified any
// long thinking/streaming window longer than HEARTBEAT_QUIET_MS as
// end-of-turn, producing false notifications and a flickering sidebar.
//
// Instead we peek at the session's transcript JSONL. Only if the last
// entry is a finished assistant message with text blocks and no pending
// tool_use do we synthesize Stop. Anything else (missing file, a user /
// tool_result entry, or an assistant entry with a tool_use block) means
// the turn is still in progress and we reschedule.
//
// All side-effects (timers, transcript I/O, state peek, stop synthesis)
// are injected so the logic is testable without fake clocks or fs fixtures.

import * as fs from 'node:fs'

interface AssistantContentBlock {
  type: string
  text?: string
}

export interface TranscriptEntry {
  type?: string
  message?: {
    content?: AssistantContentBlock[]
  }
}

const MAX_LINES_TO_SCAN = 200

/**
 * Read the last parseable JSONL entry from `transcriptPath`. Returns null
 * when the file is missing, empty, or has no parseable lines within the
 * scan window. Walks backwards so we stay O(k) in the number of trailing
 * lines we inspect.
 */
export function readLastTranscriptEntry(transcriptPath: string): TranscriptEntry | null {
  if (!transcriptPath) return null
  let content: string
  try {
    content = fs.readFileSync(transcriptPath, 'utf8')
  } catch {
    return null
  }
  const lines = content.split('\n').filter((line) => line.trim().length > 0)
  const start = Math.max(0, lines.length - MAX_LINES_TO_SCAN)
  for (let i = lines.length - 1; i >= start; i--) {
    try {
      return JSON.parse(lines[i]) as TranscriptEntry
    } catch {
      continue
    }
  }
  return null
}

/**
 * True only when `entry` represents a finished assistant turn — an
 * assistant message with at least one content block and zero tool_use
 * blocks. Any other shape (null, user/tool_result, assistant-with-tool_use,
 * assistant-with-empty-content) means the turn is still in progress.
 */
export function isTurnTrulyEnded(entry: TranscriptEntry | null): boolean {
  if (!entry) return false
  if (entry.type !== 'assistant') return false
  const blocks = entry.message?.content
  if (!Array.isArray(blocks) || blocks.length === 0) return false
  return blocks.every((b) => b && b.type === 'text')
}

export interface HeartbeatDetectorDeps {
  /** Debounce window — fire this long after the most recent schedule() call. */
  quietMs: number
  /** Resolve the current transcript path for a session, or null if unknown. */
  getTranscriptPath: (sessionId: string) => string | null
  /** Only emit a synthetic Stop when the session is still in `working`. */
  isStillWorking: (sessionId: string) => boolean
  /** Invoked when the transcript confirms end-of-turn. Called at most once per fire. */
  synthesizeStop: (sessionId: string) => void
  /** Injectable for tests. Defaults to the real fs-backed reader. */
  readLastEntry?: (transcriptPath: string) => TranscriptEntry | null
  /** Injectable for tests. Defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown
  /** Injectable for tests. Defaults to clearTimeout. */
  clearTimer?: (handle: unknown) => void
  /** Optional structured logger. Defaults to no-op. */
  log?: (...args: unknown[]) => void
}

export interface HeartbeatDetector {
  schedule(sessionId: string): void
  clear(sessionId: string): void
  clearAll(): void
}

/**
 * Build a detector instance. `schedule(id)` arms (or re-arms) the debounce;
 * `clear(id)` cancels it. Call schedule on every working-state hook event
 * and clear when the session leaves working for any reason.
 */
export function createHeartbeatDetector(deps: HeartbeatDetectorDeps): HeartbeatDetector {
  const readLastEntry = deps.readLastEntry ?? readLastTranscriptEntry
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const log = deps.log ?? (() => {})

  const timers = new Map<string, unknown>()

  function fire(sessionId: string): void {
    timers.delete(sessionId)
    if (!deps.isStillWorking(sessionId)) {
      log('[heartbeat] fire skipped: session no longer working', sessionId)
      return
    }

    const transcriptPath = deps.getTranscriptPath(sessionId)
    const entry = transcriptPath ? readLastEntry(transcriptPath) : null

    if (isTurnTrulyEnded(entry)) {
      log('[heartbeat] transcript confirms end-of-turn, synthesizing Stop', sessionId)
      deps.synthesizeStop(sessionId)
      return
    }

    log('[heartbeat] transcript says turn still active, rescheduling', sessionId, {
      transcriptPath,
      lastEntryType: entry?.type ?? null,
    })
    schedule(sessionId)
  }

  function schedule(sessionId: string): void {
    const existing = timers.get(sessionId)
    if (existing !== undefined) clearTimer(existing)
    const handle = setTimer(() => fire(sessionId), deps.quietMs)
    timers.set(sessionId, handle)
  }

  function clear(sessionId: string): void {
    const handle = timers.get(sessionId)
    if (handle !== undefined) clearTimer(handle)
    timers.delete(sessionId)
  }

  function clearAll(): void {
    for (const handle of timers.values()) clearTimer(handle)
    timers.clear()
  }

  return { schedule, clear, clearAll }
}
