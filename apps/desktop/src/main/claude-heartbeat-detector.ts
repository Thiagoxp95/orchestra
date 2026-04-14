// Transcript-gated end-of-turn detector. Claude Code's real Stop hook
// sometimes fires late or not at all (observed especially under permission-
// prompt and interrupt races), so we arm a debounce timer whenever a session
// enters `working`. When the timer fires we do NOT blindly emit a synthetic
// Stop — that misclassified any long thinking/streaming window as end-of-
// turn and produced the false "finished" notifications.
//
// Instead we peek at the session's transcript JSONL. We only synthesize Stop
// when:
//   (a) the session is still working at fire time,
//   (b) the turnId observed when we armed is still the current turnId
//       (otherwise the turn we were trying to close is already gone), AND
//   (c) the transcript scan says the turn truly ended — last meaningful
//       entry is an assistant message with text-only blocks and no
//       unmatched tool_use between that entry and the preceding user turn.
//
// Anything else reschedules. All side-effects (timers, transcript I/O,
// state peek, stop synthesis) are injected so the logic is testable without
// fake clocks or fs fixtures.

import * as fs from 'node:fs'

interface AssistantContentBlock {
  type: string
  id?: string
  tool_use_id?: string
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
 * Read the last N parseable entries (oldest first). Returns an empty array
 * when the file is missing or empty. Used by the stricter end-of-turn
 * predicate, which needs to see more than just the tail.
 */
export function readRecentTranscriptEntries(
  transcriptPath: string,
  limit: number = MAX_LINES_TO_SCAN,
): TranscriptEntry[] {
  if (!transcriptPath) return []
  let content: string
  try {
    content = fs.readFileSync(transcriptPath, 'utf8')
  } catch {
    return []
  }
  const lines = content.split('\n').filter((line) => line.trim().length > 0)
  const start = Math.max(0, lines.length - limit)
  const out: TranscriptEntry[] = []
  for (let i = start; i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]) as TranscriptEntry)
    } catch {
      continue
    }
  }
  return out
}

/**
 * Back-compat: same shape as v1. Kept for existing callers (and the test
 * suite that pins behaviour against specific entry shapes). Prefer
 * `isTurnTrulyEndedStrict(entries)` below for new callers.
 */
export function isTurnTrulyEnded(entry: TranscriptEntry | null): boolean {
  if (!entry) return false
  if (entry.type !== 'assistant') return false
  const blocks = entry.message?.content
  if (!Array.isArray(blocks) || blocks.length === 0) return false
  return blocks.every((b) => b && b.type === 'text')
}

/**
 * Stricter end-of-turn predicate operating on a window of recent transcript
 * entries (oldest-first). Returns true only when:
 *
 *   - The most recent entry is an assistant message with at least one
 *     content block and zero tool_use blocks, AND
 *   - Every tool_use that appears in the window has a matching tool_result
 *     (by tool_use_id) later in the window.
 *
 * The unmatched-tool_use guard is what v1's single-entry check missed:
 * Claude can emit a final assistant-text block *while a tool_use from an
 * earlier block is still pending its tool_result*, and a naive
 * "last entry is assistant-text" peek would synthesize Stop prematurely.
 */
export function isTurnTrulyEndedStrict(entries: TranscriptEntry[]): boolean {
  if (entries.length === 0) return false
  const last = entries[entries.length - 1]
  if (!isTurnTrulyEnded(last)) return false

  const pendingToolUseIds = new Set<string>()
  for (const entry of entries) {
    const blocks = entry.message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (!block) continue
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        pendingToolUseIds.add(block.id)
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        pendingToolUseIds.delete(block.tool_use_id)
      }
    }
  }
  return pendingToolUseIds.size === 0
}

export interface HeartbeatDetectorDeps {
  /** Debounce window — fire this long after the most recent schedule() call. */
  quietMs: number
  /** Resolve the current transcript path for a session, or null if unknown. */
  getTranscriptPath: (sessionId: string) => string | null
  /** Only emit a synthetic Stop when the session is still in `working`. */
  isStillWorking: (sessionId: string) => boolean
  /** Resolve the currently-active turn id for a session, or null if none. */
  getCurrentTurnId: (sessionId: string) => string | null
  /**
   * Invoked when the transcript confirms end-of-turn. Called at most once
   * per fire. The detector passes the turnId it observed at arm time so
   * the state machine can gate against stale synthetic Stops.
   */
  synthesizeStop: (sessionId: string, expectedTurnId: string) => void
  /** Injectable for tests. Defaults to the real fs-backed reader. */
  readRecentEntries?: (transcriptPath: string) => TranscriptEntry[]
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

interface TimerEntry {
  handle: unknown
  /** turnId observed at the moment this timer was armed. */
  turnId: string | null
}

/**
 * Build a detector instance. `schedule(id)` arms (or re-arms) the debounce;
 * `clear(id)` cancels it. Call schedule on every working-state hook event
 * and clear when the session leaves working for any reason.
 */
export function createHeartbeatDetector(deps: HeartbeatDetectorDeps): HeartbeatDetector {
  const readRecent =
    deps.readRecentEntries ??
    ((p: string) => readRecentTranscriptEntries(p))
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const log = deps.log ?? (() => {})

  const timers = new Map<string, TimerEntry>()

  function fire(sessionId: string): void {
    const armed = timers.get(sessionId)
    timers.delete(sessionId)
    if (!armed) return

    if (!deps.isStillWorking(sessionId)) {
      log('[heartbeat] fire skipped: session no longer working', sessionId)
      return
    }

    const currentTurnId = deps.getCurrentTurnId(sessionId)
    if (armed.turnId !== null && currentTurnId !== armed.turnId) {
      // Turn rotated under us — the Stop we were about to synthesize is for
      // a turn that's already been replaced. Don't reschedule; the new turn
      // will schedule its own heartbeat via the state machine.
      log('[heartbeat] fire dropped: turn rotated', sessionId, {
        armed: armed.turnId,
        current: currentTurnId,
      })
      return
    }

    const transcriptPath = deps.getTranscriptPath(sessionId)
    const entries = transcriptPath ? readRecent(transcriptPath) : []

    if (isTurnTrulyEndedStrict(entries)) {
      log('[heartbeat] transcript confirms end-of-turn, synthesizing Stop', sessionId, {
        turnId: armed.turnId,
      })
      // If armed without a turnId (rare — working emit happened before any
      // turn was assigned) we fall back to an empty string; the state
      // machine treats undefined/absent as "no assertion" but we pass the
      // observed value we'd want to close.
      deps.synthesizeStop(sessionId, armed.turnId ?? '')
      return
    }

    log('[heartbeat] transcript says turn still active, rescheduling', sessionId, {
      transcriptPath,
      lastEntryType: entries.length > 0 ? entries[entries.length - 1].type ?? null : null,
      turnId: armed.turnId,
    })
    schedule(sessionId)
  }

  function schedule(sessionId: string): void {
    const existing = timers.get(sessionId)
    if (existing !== undefined) clearTimer(existing.handle)
    const turnId = deps.getCurrentTurnId(sessionId)
    const handle = setTimer(() => fire(sessionId), deps.quietMs)
    timers.set(sessionId, { handle, turnId })
  }

  function clear(sessionId: string): void {
    const entry = timers.get(sessionId)
    if (entry !== undefined) clearTimer(entry.handle)
    timers.delete(sessionId)
  }

  function clearAll(): void {
    for (const entry of timers.values()) clearTimer(entry.handle)
    timers.clear()
  }

  return { schedule, clear, clearAll }
}
