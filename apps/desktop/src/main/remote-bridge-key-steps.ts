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

export type KeyStep = { data: string; delayAfterMs: number }

export interface KeyStepDeps {
  write: (data: string) => void
  sleep: (ms: number) => Promise<void>
}

/** More steps than any real protocol needs; a runaway payload is dropped. */
export const MAX_KEY_STEPS = 40
/** Per-step delay clamp — protocols use ≤1.2s; nothing legitimate needs more. */
export const MAX_STEP_DELAY_MS = 5_000
/** Per-step data clamp — steps are keys or short slash commands, not payloads. */
export const MAX_STEP_DATA_CHARS = 200

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
    steps.push({ data, delayAfterMs: delayMs })
  }
  return steps
}

/** Replay a sanitized sequence: write, wait the step's delay, repeat. */
export async function runKeySteps(deps: KeyStepDeps, steps: KeyStep[]): Promise<void> {
  for (const step of steps) {
    deps.write(step.data)
    if (step.delayAfterMs > 0) await deps.sleep(step.delayAfterMs)
  }
}
