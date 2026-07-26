// Detecting a mirror that has gone deaf mid-session.
//
// The terminal's chunk stream is a Convex query whose CURSOR is one of its
// arguments (`getChunks(token, sessionId, afterSeq)`), so every batch we consume
// tears the subscription down and opens a new one at the next cursor. That is what
// keeps the payload bounded, but it also means the stream's liveness depends on a
// fresh subscribe round-trip landing for every single batch. On a lossy link (5G in
// a basement, a phone handing between cells) one of those subscribes can be lost
// while the socket is half-open: the query never resolves, no chunk ever arrives,
// and the terminal is frozen — while the *upstream* path keeps working, because
// `sendCommand` is a mutation the Convex client retries on its own.
//
// The result is the reported symptom exactly: you type and nothing appears, you
// press Enter and still nothing appears, and when you kill and reopen the app the
// text was there and the command had run all along.
//
// Nothing recovers that today. The attach watchdog in Terminal.tsx gives up for
// good once the first chunk lands (`firstChunkRef`), and the foreground re-anchor
// only fires on visibilitychange — which never happens to an app you are staring
// at. So a foreground stall is unrecoverable except by hand.
//
// The signal we key on is a keystroke with no echo. A PTY answers input by echoing
// it, so a write is the one moment we can be sure output is owed to us; silence
// after it is not "the agent is thinking", it is a stream that stopped. Waiting on
// input (rather than just on silence) is what keeps an idle session from re-seeding
// itself all day.

/** How recently we must have sent input for its silence to mean anything. */
export const STALL_INPUT_WINDOW_MS = 15_000

/** Silence after that input before the stream is presumed wedged. */
export const STALL_SILENCE_MS = 4_000

/** Minimum gap between re-anchors, so a genuinely dead bridge isn't hammered. */
export const STALL_REANCHOR_COOLDOWN_MS = 10_000

export interface StallInputs {
  /** When we last relayed a keystroke to the PTY (0 = never). */
  lastInputAt: number
  /** When we last wrote a chunk into xterm (0 = never). */
  lastChunkAt: number
  /** When we last re-anchored (0 = never). */
  lastReanchorAt: number
  /** The page is on screen — a hidden page is expected to be quiet. */
  visible: boolean
  /** The Convex socket is up; re-subscribing over a dead socket fixes nothing. */
  connected: boolean
}

/**
 * Whether the chunk stream should be re-anchored (cursor reset + fresh attach).
 *
 * True only when we asked for output and got none: recently sent input, nothing
 * back for {@link STALL_SILENCE_MS}, page visible, socket up, and not already
 * re-anchored within the cooldown.
 */
export function shouldReanchor(now: number, s: StallInputs): boolean {
  if (!s.visible || !s.connected) return false
  // No input yet means nothing is owed to us — the attach watchdog owns that phase.
  if (s.lastInputAt <= 0) return false
  if (now - s.lastInputAt > STALL_INPUT_WINDOW_MS) return false
  if (now - s.lastChunkAt < STALL_SILENCE_MS) return false
  // Input that predates the last chunk was already answered; only silence *since*
  // the keystroke counts.
  if (s.lastChunkAt > s.lastInputAt) return false
  if (s.lastReanchorAt > 0 && now - s.lastReanchorAt < STALL_REANCHOR_COOLDOWN_MS) return false
  return true
}
