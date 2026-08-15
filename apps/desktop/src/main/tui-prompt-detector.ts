// Surfacing TUI-native prompts (folder trust, tool permission, "proceed?") in
// the phone's chat as tappable cards.
//
// These prompts have NO transcript record and NO hook: the folder-trust gate in
// particular BLOCKS claude before it writes any JSONL, so the phone's chat is
// empty and the AskUserQuestion hook never fires — the user sees nothing while
// the agent sits waiting. The only place the prompt exists is on the terminal
// screen, so the mirror scrapes it from the session's output buffer
// (getTerminalBufferText, the ANSI-stripped stream tail main already keeps) and
// rides a structured `tuiPrompt` on liveStatus. The phone renders the options
// and answers by typing the same keys a person would.
//
// The scrape is a heuristic over text claude can reword on any CLI update, so it
// is deliberately conservative: it fires only when the prompt's own footer is at
// the TAIL of the buffer (a live prompt is the last thing printed; once answered
// the reply floods past it), and every answer key carries an `ifScreenContains`
// guard so a card the mirror is slow to clear can never rain keystrokes into a
// composer. Re-probe the exact copy against a real TUI before editing — see the
// question-cards memory; this changes with the CLI.

import type { KeyStep } from './remote-bridge-key-steps'

export type TuiPromptKind = 'trust' | 'proceed'

export interface TuiPromptOption {
  label: string
  /** Distinct from the others so the phone can style the primary action. */
  primary?: boolean
  /** Exactly the keys a person would press; each carries the staleness guard. */
  keys: KeyStep[]
}

export interface TuiPrompt {
  kind: TuiPromptKind
  title: string
  detail?: string
  options: TuiPromptOption[]
}

// The buffer is the ANSI-stripped, space-collapsed STREAM tail (4KB), not a
// rendered screen — a dismissed prompt lingers until 4KB more output scrolls it
// out. Requiring the match in this trailing window is the "prompt is live now"
// signal: the footer sits at the very end while the prompt shows, and the reply
// appends past it the moment it is answered.
const TAIL_CHARS = 900

function tail(screen: string): string {
  return screen.length > TAIL_CHARS ? screen.slice(-TAIL_CHARS) : screen
}

/** ~250ms between the digit and the confirming Enter — the list widget needs a
 *  beat to move the selection before Enter commits it. */
const SELECT_MS = 250

/** Build a "type digit N, then Enter" answer, both guarded on `guard` so a
 *  stale card is a no-op instead of two stray keys in the composer. */
function digitThenEnter(digit: string, guard: string): KeyStep[] {
  return [
    { data: digit, delayAfterMs: SELECT_MS, ifScreenContains: guard },
    { data: '\r', delayAfterMs: 0, ifScreenContains: guard },
  ]
}

/**
 * The folder-trust gate (claude 2.1.233):
 *   Quick safety check: Is this a project you created or one you trust? …
 *   ❯ 1. Yes, I trust this folder
 *     2. No, exit
 *   Enter to confirm · Esc to cancel
 * Blocks before any transcript, so this scrape is the ONLY way it reaches chat.
 */
const TRUST_GUARD = 'trust this folder'
function detectTrust(screen: string): TuiPrompt | null {
  const t = tail(screen).toLowerCase()
  if (!t.includes(TRUST_GUARD)) return null
  // Both real prompts that mention "trust this folder" carry this confirm
  // footer; requiring it avoids firing on prose that happens to say the phrase.
  if (!t.includes('enter to confirm') && !t.includes('yes, i trust')) return null
  return {
    kind: 'trust',
    title: 'Trust this folder?',
    detail: 'Claude Code needs permission to read, edit, and run files in this workspace before it can start.',
    options: [
      { label: 'Yes, I trust this folder', primary: true, keys: digitThenEnter('1', TRUST_GUARD) },
      { label: 'No, exit', keys: digitThenEnter('2', TRUST_GUARD) },
    ],
  }
}

/**
 * The tool-permission gate ("Do you want to proceed?"). Rare under Orchestra's
 * --dangerously-skip-permissions launch, but real for plan-mode approvals and
 * any tool the model routes for review. Shape (claude): a "Do you want to
 * proceed?" line, numbered Yes / "Yes, and don't ask again" / No options.
 */
const PROCEED_GUARD = 'do you want to proceed'
function detectProceed(screen: string): TuiPrompt | null {
  const t = tail(screen).toLowerCase()
  if (!t.includes(PROCEED_GUARD)) return null
  if (!t.includes('esc to cancel') && !t.includes('1. yes')) return null
  const options: TuiPromptOption[] = [{ label: 'Yes', primary: true, keys: digitThenEnter('1', PROCEED_GUARD) }]
  // "Yes, and don't ask again" is option 2 when present; No is the last row.
  if (t.includes("don't ask again") || t.includes('do not ask again')) {
    options.push({ label: "Yes, don't ask again", keys: digitThenEnter('2', PROCEED_GUARD) })
    options.push({ label: 'No', keys: [{ data: '\x1b', delayAfterMs: 0, ifScreenContains: PROCEED_GUARD }] })
  } else {
    options.push({ label: 'No', keys: [{ data: '\x1b', delayAfterMs: 0, ifScreenContains: PROCEED_GUARD }] })
  }
  return {
    kind: 'proceed',
    title: 'Allow this action?',
    detail: 'The agent is waiting for permission to proceed.',
    options,
  }
}

const DETECTORS = [detectTrust, detectProceed]

/**
 * The TUI-native prompt currently on this session's screen, or null. Pure over
 * the (already ANSI-stripped) buffer text so it unit-tests without a PTY.
 */
export function detectTuiPrompt(screen: string): TuiPrompt | null {
  if (!screen) return null
  for (const detect of DETECTORS) {
    const prompt = detect(screen)
    if (prompt) return prompt
  }
  return null
}
