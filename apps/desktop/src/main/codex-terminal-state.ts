const CODEX_INTERRUPTED_PROMPT_RE = /Conversation interrupted\s*-\s*tell the model what to do differently/i

// Match codex's prompt-ready footer (the `›` input line plus the
// `<model> … · ~/path` status line). We intentionally avoid requiring a
// newline between the two: when codex redraws the TUI via cursor
// positioning, normalizeTerminalChunk strips the CSI escapes without
// inserting newlines, leaving the input line and the footer glued together.
//
// The editable prompt may be empty after an interrupt, or very long while the
// user is composing/pasting a follow-up. Either way, seeing the footer means
// codex is back at the input prompt unless the live working banner is present.
// The cap stays below the rolling buffer so stale prompt text cannot match
// forever after large output bursts.
const CODEX_PROMPT_READY_RE = /›[\s\S]{0,3500}?(?:gpt|o\d|codex|[a-z0-9_.-]+\/[a-z0-9_.:-]+)\S*\s+.+?·\s+~?\//i

// Codex paints "<activity> (Ns · esc to interrupt)" inside the prompt box
// while a turn is in flight. The banner sits between the typed input line and
// the model footer, so PROMPT_READY matches the working TUI just as readily
// as the idle TUI. Track the wall-clock time we last saw this marker and
// suppress prompt-ready until enough quiet has passed — buffer-only detection
// is unreliable because a single chunk of diff/file output can easily exceed
// the 4KB rolling window and flush the banner even though codex emits another
// tick a moment later. Once the turn ends, the banner stops being emitted and
// the grace window expires, so /fast-style runs (no Stop hook) still recover.
const CODEX_WORKING_BANNER_RE = /\(\s*\d+\s*(?:ms|s|m|h)(?:\s+\d+\s*(?:ms|s|m|h))*\s*·\s*esc to interrupt\s*\)/i

// Codex's activity banner re-emits roughly every 100ms while a turn is
// running; 2s is comfortably more than several ticks but short enough that
// the spinner clears quickly when the turn ends without a Stop hook.
const WORKING_BANNER_GRACE_MS = 2000

const ROLLING_BUFFER_BYTES = 4096

interface SessionTerminalState {
  buffer: string
  // End offset (in the normalized buffer) of the most recent prompt-ready
  // match we already reported. -1 means we have not reported one yet.
  // Compared against the *last* match in the buffer so a re-render past the
  // prior match fires again — that matters when codex repaints the prompt
  // after a slash command while we already remember the pre-prompt UI.
  promptReadyMatchEnd: number
  interruptedMatchEnd: number
  // Wall-clock time (ms) we last observed the working banner in any chunk.
  // 0 means we have never seen it for this session.
  lastWorkingBannerAt: number
}

const sessionStates = new Map<string, SessionTerminalState>()

// Strip the escape/control noise that often surrounds Codex TUI text before
// matching user-visible status lines.
function normalizeTerminalChunk(chunk: string): string {
  return chunk
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r/g, '\n')
    .replace(/\x07/g, '\n')
}

export function chunkIndicatesCodexInterruptedPrompt(chunk: string): boolean {
  return CODEX_INTERRUPTED_PROMPT_RE.test(normalizeTerminalChunk(chunk))
}

export function chunkIndicatesCodexPromptReady(chunk: string): boolean {
  return CODEX_PROMPT_READY_RE.test(normalizeTerminalChunk(chunk))
}

function findLastMatchEnd(text: string, source: RegExp): number {
  // Scan with a fresh global regex so the source pattern's lastIndex isn't
  // mutated and we get every occurrence in the buffer.
  const flags = source.flags.includes('g') ? source.flags : `${source.flags}g`
  const re = new RegExp(source.source, flags)
  let lastEnd = -1
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    lastEnd = match.index + match[0].length
    if (match[0].length === 0) re.lastIndex++
  }
  return lastEnd
}

export interface CodexTerminalSignals {
  working: boolean
  promptReady: boolean
  interrupted: boolean
}

/**
 * Append a PTY chunk into the per-session rolling buffer and return whether a
 * new occurrence of either signal has shown up since the last call: codex
 * returning to the prompt, or codex surfacing the interrupted-conversation
 * banner.
 *
 * The "new occurrence" check matters. Once a signature matches, it lingers
 * in the rolling buffer for thousands of bytes, but a *re-render* of the
 * prompt UI is exactly what we need to detect to recover from slash
 * commands like `/fast` — they fire UserPromptSubmit, never fire Stop, and
 * the only sign that codex finished is that the prompt UI repaints. We
 * track the end offset of the previously-reported match and only fire
 * again when the buffer's most-recent match ends past it. The buffer is
 * capped at `ROLLING_BUFFER_BYTES`; the stored match offset shifts back
 * with the buffer when it trims so the comparison stays meaningful.
 */
export function feedCodexTerminalChunk(sessionId: string, chunk: string): CodexTerminalSignals {
  const state = sessionStates.get(sessionId)
    ?? { buffer: '', promptReadyMatchEnd: -1, interruptedMatchEnd: -1, lastWorkingBannerAt: 0 }

  const normalizedChunk = normalizeTerminalChunk(chunk)
  const combined = state.buffer + normalizedChunk
  let trimmed = 0
  if (combined.length > ROLLING_BUFFER_BYTES) {
    trimmed = combined.length - ROLLING_BUFFER_BYTES
    state.buffer = combined.slice(trimmed)
  } else {
    state.buffer = combined
  }
  if (trimmed > 0) {
    state.promptReadyMatchEnd = state.promptReadyMatchEnd >= 0
      ? Math.max(-1, state.promptReadyMatchEnd - trimmed)
      : -1
    state.interruptedMatchEnd = state.interruptedMatchEnd >= 0
      ? Math.max(-1, state.interruptedMatchEnd - trimmed)
      : -1
  }

  const now = Date.now()
  const working = CODEX_WORKING_BANNER_RE.test(normalizedChunk)
  if (working) {
    state.lastWorkingBannerAt = now
  }

  const promptReadyEnd = findLastMatchEnd(state.buffer, CODEX_PROMPT_READY_RE)
  const interruptedEnd = findLastMatchEnd(state.buffer, CODEX_INTERRUPTED_PROMPT_RE)
  const codexProbablyWorking = CODEX_WORKING_BANNER_RE.test(state.buffer)
    || (state.lastWorkingBannerAt > 0
      && now - state.lastWorkingBannerAt < WORKING_BANNER_GRACE_MS)

  const promptReadyFires = promptReadyEnd >= 0
    && promptReadyEnd > state.promptReadyMatchEnd
    && !codexProbablyWorking
  const interruptedFires = interruptedEnd >= 0 && interruptedEnd > state.interruptedMatchEnd

  if (promptReadyFires) state.promptReadyMatchEnd = promptReadyEnd
  if (interruptedFires) state.interruptedMatchEnd = interruptedEnd
  sessionStates.set(sessionId, state)

  return { working, promptReady: promptReadyFires, interrupted: interruptedFires }
}

export function clearCodexTerminalState(sessionId: string): void {
  sessionStates.delete(sessionId)
}

export function clearAllCodexTerminalState(): void {
  sessionStates.clear()
}
