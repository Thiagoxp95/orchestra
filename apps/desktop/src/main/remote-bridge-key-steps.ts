// Paced key sequences for phone-driven TUI protocols (model/effort slash
// commands, AskUserQuestion answers).
//
// The web used to send each keystroke as its own `write` command with the
// pacing applied CLIENT-side between mutations. That pacing does not survive
// the trip: mutation round-trips and subscription delivery add ±hundreds of ms
// of jitter to every gap, and claude-code's slash handling has a real timing
// window — a CR ~350ms after "/effort high" executes the command, while a CR
// two seconds later is eaten by the autocomplete popup and the command
// silently never runs (probe-verified on 2.1.222: direct writes at
// 120/350/600ms apply; the same steps with 2s gaps "submit" per the daemon's
// prompt history but never execute). So the phone's picker worked only when
// the network happened to preserve the gaps — i.e. rarely.
//
// The fix: the web sends ONE command carrying the whole sequence, and the
// bridge replays it here with the exact delays at the PTY, where no jitter
// exists. Old desktops ignore the `steps` payload field and write the empty
// legacy `data` — a harmless no-op instead of a corrupted half-sequence.

export type KeyStep = {
  data: string
  delayAfterMs: number
  /**
   * Send this step ONLY when the session's recent terminal text matches this
   * (case-insensitive substring). claude 2.1.222 answers `/effort <level>` on a
   * cached conversation with a "Change effort level?" confirmation
   * ("1. Yes, switch to high" / "2. No, go back") — the switch sits there
   * unconfirmed forever, which reads on the phone as another silent no-op. The
   * phone cannot see the screen; the bridge can, so the confirming digit rides
   * along as a conditional step and is skipped when no dialog appeared (typing
   * a bare "1" into an idle composer would send "1" to the agent).
   */
  ifScreenContains?: string
}

export interface KeyStepDeps {
  write: (data: string) => void
  sleep: (ms: number) => Promise<void>
  /** ANSI-stripped tail of the session's terminal output. */
  readScreen?: () => string
}

/** More steps than any real protocol needs; a runaway payload is dropped. */
export const MAX_KEY_STEPS = 40
/** Per-step delay clamp — protocols use ≤1.2s; nothing legitimate needs more. */
export const MAX_STEP_DELAY_MS = 5_000
/** Per-step data clamp — steps are keys or short slash commands, not payloads. */
export const MAX_STEP_DATA_CHARS = 200
/** Guard clamp — a needle is a dialog phrase, not a document. */
export const MAX_STEP_GUARD_CHARS = 120

/**
 * Validate an untrusted `payload.steps`. Returns null when the shape is wrong
 * (not an array, empty, oversized, or any malformed step) — the caller falls
 * back to the legacy single-write path rather than typing garbage into a TUI.
 */
export function sanitizeKeySteps(raw: unknown): KeyStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_KEY_STEPS) return null
  const steps: KeyStep[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const data = (item as { data?: unknown }).data
    const delay = (item as { delayAfterMs?: unknown }).delayAfterMs
    if (typeof data !== 'string' || data.length === 0 || data.length > MAX_STEP_DATA_CHARS) return null
    const delayMs =
      typeof delay === 'number' && Number.isFinite(delay)
        ? Math.min(Math.max(0, delay), MAX_STEP_DELAY_MS)
        : 0
    const guard = (item as { ifScreenContains?: unknown }).ifScreenContains
    if (guard !== undefined && (typeof guard !== 'string' || guard.length === 0 || guard.length > MAX_STEP_GUARD_CHARS))
      return null
    steps.push({
      data,
      delayAfterMs: delayMs,
      ...(typeof guard === 'string' ? { ifScreenContains: guard } : {}),
    })
  }
  return steps
}

/**
 * Replay a sanitized sequence: write, wait the step's delay, repeat. A step
 * carrying `ifScreenContains` is written only when the session's current screen
 * text holds that phrase (see the field's docs) — and, when skipped, its delay
 * is skipped too, so an absent dialog costs nothing.
 */
export async function runKeySteps(deps: KeyStepDeps, steps: KeyStep[]): Promise<void> {
  for (const step of steps) {
    if (step.ifScreenContains) {
      const screen = deps.readScreen?.() ?? ''
      if (!screen.toLowerCase().includes(step.ifScreenContains.toLowerCase())) continue
    }
    deps.write(step.data)
    if (step.delayAfterMs > 0) await deps.sleep(step.delayAfterMs)
  }
}
