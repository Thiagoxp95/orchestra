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
  // what let a stale attachment survive and ride along with the next message.
  deps.write('\x15')
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
