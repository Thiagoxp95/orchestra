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

// A prompt typed into an agent by another agent (MCP send_input) went wrong in
// two ways, both PTY-proven against claude 2.1.310:
//
// - Written raw as one write, it never arrives as one paste. Before the TUI is in
//   raw mode the tty is still cooked and keeps only the first 1024 bytes; once it
//   is, the PTY hands it over in <=1024-byte reads and claude makes each read its
//   own paste, cut mid-word, so the agent got a fragment or a pile of pieces.
// - Enter followed it at once: settle() measures silence from the last output,
//   which predates our write, so it passed instantly and "\r" rode in the same
//   read as the text. The TUI took the CR as part of the paste, so nothing was
//   submitted. Pressing Enter by hand then got claude's submit guard, which
//   strips the stray CR, says "Removed 1 invisible character - review and press
//   Enter to send" and holds the draft for another Enter.
//
// So: wait for the TUI to switch bracketed paste on (it is up and reading), send
// the whole prompt as one bracketed paste with nothing in it the guard would
// strip, let the TUI answer before pressing Enter, and check that it took.

/** Longest we wait for a just-opened agent's TUI to come up. */
export const READY_CAP_MS = 15_000
/** How long a pressed Enter has to show up as a submitted turn. */
export const SUBMIT_CONFIRM_MS = 3_000
/** Extra Enters for a prompt still sitting in the composer. */
export const ENTER_RETRIES = 2

// Everything claude's submit guard removes (C0 controls but tab and line feed,
// DEL and C1, zero-width, bidi, BOM, variation selectors, tags), so a pasted
// prompt never trips it. ESC goes too, which also keeps the text from ending
// its own bracketed paste early.
const INVISIBLE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\u{e0000}-\u{e0fff}]/gu

/** The prompt as the agent should receive it: line breaks as LF, no invisible characters. */
export function cleanPrompt(text: string): string {
  return text.replace(/\r\n?|[\v\f\x85\u2028\u2029]/g, '\n').replace(INVISIBLE, '')
}

const squash = (s: string) => s.replace(/\s+/g, '')

/** Whether the bottom of the screen still shows `prompt` unsent in the composer. */
export function draftVisible(screen: string, prompt: string): boolean {
  const head = squash(prompt).slice(0, 24)
  const bottom = squash(screen)
  return (head !== '' && bottom.includes(head)) || /\[Pasted(text|Content)/i.test(bottom)
}

export interface PromptSendDeps extends TuiWriteDeps {
  /** True once the TUI has turned bracketed paste on: it is up and reading. */
  isReady: () => Promise<boolean>
  /** True once the agent took a turn (started working, or logged the message). */
  isSubmitted: () => boolean
  /** The bottom of the screen, where the composer is. */
  readScreen: () => Promise<string>
}

/** Paste a prompt into an agent's composer and submit it. */
export async function sendPrompt(
  deps: PromptSendDeps,
  text: string,
  submit = true,
): Promise<{ ready: boolean; submitted: boolean; enters: number }> {
  const prompt = cleanPrompt(text)
  let ready = await deps.isReady()
  for (let waited = 0; !ready && waited < READY_CAP_MS; waited += 200) {
    await deps.sleep(200)
    ready = await deps.isReady()
  }
  await settle(deps)
  // A TUI that never turned bracketed paste on would show the markers as text.
  deps.write(ready ? `\x1b[200~${prompt}\x1b[201~` : prompt)
  // Give the TUI time to answer the paste first, or settle() passes at once.
  await deps.sleep(QUIET_MS)
  await settle(deps)
  if (!submit) return { ready, submitted: false, enters: 0 }

  let enters = 0
  while (enters <= ENTER_RETRIES) {
    deps.write('\r')
    enters++
    for (let waited = 0; waited < SUBMIT_CONFIRM_MS; waited += 200) {
      if (deps.isSubmitted()) return { ready, submitted: true, enters }
      await deps.sleep(200)
    }
    if (!draftVisible(await deps.readScreen(), prompt)) break
  }
  return { ready, submitted: deps.isSubmitted(), enters }
}
