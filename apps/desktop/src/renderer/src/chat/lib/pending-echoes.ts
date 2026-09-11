/**
 * Optimistic echoes have to outlive the pane that made them, for the same
 * reason the composer's draft does (see composer-draft.ts): ChatPane is
 * unmounted by an ordinary app switch — TerminalPane is re-keyed on every
 * foreground — and by the Chat⌁Term pill, which renders the overlay only in
 * chat mode. Held in component state, an echo died on both.
 *
 * That is exactly what a phone user does after sending into a working agent:
 * flick to Term to watch the TUI, come back, and find the message gone from the
 * conversation with nothing in its place. The transcript's own copy can be a
 * long time coming — claude queues a message typed mid-turn and only records it
 * when it takes it back out (see the queue section of the desktop's
 * agent-message-model), so between those two moments the echo is the ONLY thing
 * that says the send happened.
 *
 * Module-level only, no localStorage half: an echo is a claim about the current
 * document's in-flight send, and it is retired by the mirror the moment the
 * real message lands. Nothing about it is worth restoring into a fresh page.
 */
import type { PendingEcho } from './chat-messages'

const parked = new Map<string, PendingEcho[]>()
const listeners = new Map<string, Set<() => void>>()
const EMPTY_ECHOES: PendingEcho[] = []

/**
 * Safety valve for an echo whose real message never arrives — the PTY died, or
 * the agent was killed with the message still queued. Without it a doomed
 * bubble would now sit at the end of the conversation for the life of the tab,
 * which is worse than the old behaviour of losing it on the next remount.
 */
export const ECHO_MAX_AGE_MS = 30 * 60 * 1000

export function parkEchoes(sessionId: string, echoes: PendingEcho[]): void {
  updateEchoes(sessionId, () => echoes)
}

/** The stable snapshot used by useSyncExternalStore. It does no time-based work. */
export function getEchoSnapshot(sessionId: string): PendingEcho[] {
  return parked.get(sessionId) ?? EMPTY_ECHOES
}

/** Resolve an update against the latest snapshot, including after a remount. */
export function updateEchoes(
  sessionId: string,
  updater: (current: PendingEcho[]) => PendingEcho[],
): PendingEcho[] {
  const current = getEchoSnapshot(sessionId)
  const requested = updater(current)
  if (
    requested === current ||
    (requested.length === current.length && requested.every((echo, index) => echo === current[index]))
  ) {
    return current
  }
  const next = requested.length > 0 ? requested : EMPTY_ECHOES
  if (next === EMPTY_ECHOES) parked.delete(sessionId)
  else parked.set(sessionId, next)
  for (const listener of listeners.get(sessionId) ?? []) listener()
  return next
}

/** Subscribe to one session. Expiry is checked once as that mount attaches. */
export function subscribeEchoes(sessionId: string, listener: () => void): () => void {
  loadEchoes(sessionId)
  let sessionListeners = listeners.get(sessionId)
  if (!sessionListeners) {
    sessionListeners = new Set()
    listeners.set(sessionId, sessionListeners)
  }
  sessionListeners.add(listener)
  return () => {
    sessionListeners.delete(listener)
    if (sessionListeners.size === 0) listeners.delete(sessionId)
  }
}

/** What a fresh mount starts from: the parked echoes, minus the stale ones. */
export function loadEchoes(sessionId: string, now = Date.now()): PendingEcho[] {
  const held = getEchoSnapshot(sessionId)
  if (held.length === 0) return held
  const fresh = held.filter((e) => now - (e.message.ts ?? 0) < ECHO_MAX_AGE_MS)
  return fresh.length === held.length ? held : updateEchoes(sessionId, () => fresh)
}
