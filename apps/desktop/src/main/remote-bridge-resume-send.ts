// Delivering a chat message that ARRIVED FOR A DEAD PANE.
//
// The phone's chat composer no longer refuses when a session's process is gone:
// if the pane still knows which conversation it was holding, typing into it
// resumes that conversation and the message you typed is the first thing the
// agent reads. That is one gesture on the phone and three separate things here —
// respawn the PTY (the renderer owns it), wait out the CLI's boot, then submit —
// with a gate in the middle that has no keyboard behind it.
//
// The boot is the whole problem. `submitChatMessage` paces itself against
// silence, and a booting agent is silent for a beat before it has a composer at
// all, so a send fired at the resume lands in the void: claude has not drawn its
// input line yet, and the paste is swallowed by whatever is still painting. So
// this waits for the resumed process to speak AT ALL, then for it to stop, and
// only then hands the body to the normal send path.
//
// The gate: a resumed claude can open on the folder-trust prompt, which blocks
// before it writes any transcript. On the phone that surfaces as a card the user
// taps (see tui-prompt-detector.ts) — but nobody is looking at a resume the
// composer triggered, so an unanswered gate means the message is simply never
// delivered. Every prompt is answered here with its widest affirmative
// (resolveAutoAnswer), capped so a prompt loop can't type forever.

import { settle, submitChatMessage, type ChatSendDeps } from './remote-bridge-chat-send'
import { resolveAutoAnswer, type TuiPrompt } from './tui-prompt-detector'
import type { KeyStep } from './remote-bridge-key-steps'

/** How often we look for the first sign of life from the respawned process. */
const BOOT_POLL_MS = 100
/**
 * Longest we wait for the resumed process to print anything. Generous: the
 * renderer has to see the store change, remount the pane, and create a PTY
 * before the CLI even starts, and `claude --resume` reads the transcript back
 * off disk. When it elapses with nothing, the resume did not happen (the row
 * had no conversation, the renderer was busy) and the message is NOT submitted —
 * pasting into a dead pane is exactly the silent loss this whole path exists to
 * avoid.
 */
const BOOT_CAP_MS = 45_000
/** Longest we spend on the boot's own output settling down before we type. */
const READY_CAP_MS = 30_000
/** After answering a gate, how long to let the TUI react before looking again. */
const PROMPT_SETTLE_CAP_MS = 8_000
/**
 * Gates we will clear unattended before giving up. Trust is one; a permission
 * gate behind it is two. Past that the screen is not a prompt we understand and
 * more keys would just be noise in a composer.
 */
const MAX_AUTO_ANSWERS = 3

export interface ResumeSendDeps extends ChatSendDeps {
  /** True once the respawned process has produced output since the resume was sent. */
  sawOutput: () => boolean
  /** The prompt currently on this session's screen, or null. */
  readPrompt: () => TuiPrompt | null
  /** Drive an answer's key steps (each carries its own staleness guard). */
  runKeys: (keys: KeyStep[]) => Promise<void>
  /**
   * Whether the daemon actually holds a PTY for this session, asked once right
   * before we type. `sawOutput` alone can be fooled: killing the old process
   * writes its own death rattle into the same buffer, so a resume that never
   * happened can look like one that did. This is the authoritative second
   * opinion, and it is cheap because it is asked once, after the wait, not in
   * the poll loop.
   */
  isAlive: () => Promise<boolean>
}

export interface ResumeSendResult {
  /** False when the resume never produced a live process — nothing was typed. */
  delivered: boolean
  /** Gates cleared on the way in, for the log. */
  autoAnswered: number
}

/**
 * Wait for a just-resumed session to come up, clear whatever it asks on the way,
 * and submit `body` into it. Returns without typing when the resume never
 * produced a live process.
 */
export async function deliverAfterResume(
  deps: ResumeSendDeps,
  body: string,
  now: () => number = Date.now,
): Promise<ResumeSendResult> {
  const startedAt = now()
  // 1. Wait for the respawned process to say anything at all.
  while (now() - startedAt < BOOT_CAP_MS) {
    if (deps.sawOutput()) break
    await deps.sleep(BOOT_POLL_MS)
  }
  if (!deps.sawOutput()) return { delivered: false, autoAnswered: 0 }

  // 2. Let the boot finish, answering any gate it stops on. Each answer restarts
  //    the wait: the reply repaints the screen and the next gate (or the
  //    composer) only appears after that.
  let autoAnswered = 0
  const readyDeadline = now() + READY_CAP_MS
  while (now() < readyDeadline) {
    await settle(deps, Math.max(0, Math.min(PROMPT_SETTLE_CAP_MS, readyDeadline - now())))
    const prompt = deps.readPrompt()
    if (!prompt || autoAnswered >= MAX_AUTO_ANSWERS) break
    const keys = resolveAutoAnswer(prompt)
    if (!keys) break
    autoAnswered++
    await deps.runKeys(keys)
  }

  // 3. Confirm there is something to type INTO before typing. A paste into a
  //    session the daemon has never heard of is the silent loss this path
  //    exists to prevent, and it is better to strand the message on the phone
  //    (where its echo is still visible) than to feed it to nothing.
  if (!(await deps.isAlive())) return { delivered: false, autoAnswered }

  // 4. Normal send path from here: it clears the composer and paces the paste.
  await submitChatMessage(deps, body)
  return { delivered: true, autoAnswered }
}
