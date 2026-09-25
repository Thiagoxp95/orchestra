// Pacing for writes the phone sends into an agent TUI.
//
// The naive recipe — write the bracketed paste, then move on — races the TUI.
// When the paste contains an image path, the TUI stops to read and encode the
// file before it is ready for more input; a 1-2MB phone photo takes far longer
// than the blind delay that used to guard this. Input that lands inside that
// window is dropped: probes showed a second typed path silently swallowed, and a
// send that never submitted, leaving "[Image #N]" sitting in the composer.
// Small screenshots fit inside the old delay, which is why this only ever bit
// real photos.
//
// So every step waits for the terminal to fall silent before the next one, with
// a cap: while the agent is mid-turn output never stops, and there the cap is
// what we want — the text is queued either way and the agent won't read it until
// the turn ends, so the extra wait costs nothing visible.

/** Silence that means the TUI finished reacting to the last write. */
export const QUIET_MS = 250
/** Longest we wait for silence at any one step (mid-turn output never stops). */
export const SETTLE_CAP_MS = 4_000

export interface TuiWriteDeps {
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
  deps: TuiWriteDeps,
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
 * Type a path into the composer without submitting — the phone's image button.
 * The person keeps composing at the keyboard, so this never presses Enter.
 * Settling on both sides is what stops back-to-back sends from landing inside
 * each other's ingestion window, which silently dropped the second path.
 */
export async function typeImagePath(deps: TuiWriteDeps, filePath: string): Promise<void> {
  await settle(deps)
  deps.write(`${filePath} `)
  await settle(deps)
}
