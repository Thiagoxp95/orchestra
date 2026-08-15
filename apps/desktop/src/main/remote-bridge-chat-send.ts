// Pacing for phone-composed messages written into an agent TUI.
//
// The naive recipe — one write carrying Ctrl-U + the bracketed paste, then a
// blind 150ms CR — races the TUI. When the paste contains an image path, the
// TUI stops to read and encode the file before it is ready for more input; a
// 1-2MB phone photo takes far longer than 150ms. Input that lands inside that
// window is dropped: probes showed a second typed path silently swallowed, a
// Ctrl-U doing nothing (so the stale path was glued onto the next message), and
// a send that never submitted, leaving "[Image #N]" sitting in the composer with
// the message queued but never delivered. Small screenshots fit inside 150ms,
// which is why this only ever bit real photos.
//
// So every step waits for the terminal to fall silent before the next one, with
// a cap: while the agent is mid-turn output never stops, and there the cap is
// what we want — the message is queued either way and the agent won't read it
// until the turn ends, so the extra wait costs nothing visible.

/** Silence that means the TUI finished reacting to the last write. */
export const QUIET_MS = 250
/** Longest we wait for silence at any one step (mid-turn output never stops). */
export const SETTLE_CAP_MS = 4_000
/** Floor for the CR after a paste — the proven text-only pacing. */
export const MIN_CR_DELAY_MS = 150

// Clearing the composer before pasting. ONE Ctrl-U only deletes the current
// VISUAL line (claude's deleteToLineStart works on the wrapped line), so a
// wrapped or multi-line draft already sitting in the TUI — a dictation
// paragraph typed there, text left at the desk — survives a single Ctrl-U and
// the pasted message glues onto its tail. A burst of Ctrl-U walks up every
// visual line and clears the whole thing, and is a no-op when the line is
// already empty.
//
// The burst must reach the TUI as 79 SEPARATE writes, one byte each. Written as
// one 79-byte chunk it arrives in a single stdin read, and claude 2.1.233 reads
// a multi-byte chunk as PASTED TEXT: the NAKs are inserted literally instead of
// obeyed, the stale draft survives, and the message the agent finally receives
// begins with 79 control characters (PTY-probed against 2.1.233 — one chunk
// submitted "hello leftover draft\x15…\x15ping", the drip submitted "ping").
// That is what put a wall of invisible glyphs in front of phone-sent messages.
export const CLEAR_BYTE = '\x15'
export const CLEAR_BURST_LEN = 79
/** Gap between the burst's single-byte writes — enough to keep them separate reads. */
export const CLEAR_BYTE_GAP_MS = 4
/** Legacy shape of the burst, still recognized on the wire (see runKeySteps). */
export const CLEAR_INPUT = CLEAR_BYTE.repeat(CLEAR_BURST_LEN)

/** Write a Ctrl-U burst as individual keypresses. See CLEAR_INPUT. */
export async function writeClearInput(
  deps: Pick<ChatSendDeps, 'write' | 'sleep'>,
  count = CLEAR_BURST_LEN,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    deps.write(CLEAR_BYTE)
    await deps.sleep(CLEAR_BYTE_GAP_MS)
  }
}

export interface ChatSendDeps {
  write: (data: string) => void
  /** True when the session has produced no output for at least `quietMs`. */
  isQuiet: (quietMs: number) => boolean
  sleep: (ms: number) => Promise<void>
}

/**
 * Wait until the session stops emitting, or the cap elapses. Returns the time
 * waited; `capped` tells the caller silence was never reached (agent working).
 */
export async function settle(
  deps: ChatSendDeps,
  capMs = SETTLE_CAP_MS,
  quietMs = QUIET_MS,
): Promise<{ waitedMs: number; capped: boolean }> {
  const step = 50
  let waited = 0
  while (waited < capMs) {
    if (deps.isQuiet(quietMs)) return { waitedMs: waited, capped: false }
    await deps.sleep(step)
    waited += step
  }
  return { waitedMs: waited, capped: true }
}

/**
 * Clear the composer, paste the message, and submit it — each step paced so the
 * TUI has actually caught up. `body` is the full message ("<path> <path> text").
 */
export async function submitChatMessage(deps: ChatSendDeps, body: string): Promise<void> {
  // Clear on its own write, then let it land. Batching this with the paste is
  // what let a stale attachment survive and ride along with the next message —
  // and a single Ctrl-U only clears one visual line, so the burst is what
  // actually empties a wrapped/multi-line draft before the paste.
  await writeClearInput(deps)
  await settle(deps)

  deps.write(`\x1b[200~${body}\x1b[201~`)
  // The expensive step: the TUI reads every pasted image path off disk here.
  const { waitedMs } = await settle(deps)
  if (waitedMs < MIN_CR_DELAY_MS) await deps.sleep(MIN_CR_DELAY_MS - waitedMs)

  deps.write('\r')
}

/**
 * Type a path into the composer without submitting (the terminal view's image
 * button — the user keeps composing at the keyboard). Paced the same way so
 * back-to-back sends don't land inside each other's ingestion window, which
 * silently dropped the second path.
 */
export async function typeImagePath(deps: ChatSendDeps, filePath: string): Promise<void> {
  await settle(deps)
  deps.write(`${filePath} `)
  await settle(deps)
}
