// Serialized, self-healing queue for applying remote command batches.
//
// Commands must not interleave: applying one can take seconds (a paced key
// sequence typed into a TUI), and a subscription update landing mid-sequence
// must not start draining the next batch into the same PTY on top of it.
//
// The naive serialization — `chain = chain.then(() => apply(batch))` — has a
// permanent-death mode that shipped in v1.21.28 and killed EVERY phone→desktop
// command (typing, attach, actions, model switches) until the app restarted:
// once any batch rejects, the chain holds a rejected promise and every later
// `.then()` short-circuits forever, silently. State pushes kept working, so the
// bridge looked perfectly healthy while nothing it was told to do happened.
//
// So: swallow the previous failure before queueing, and swallow our own after.
// A batch that throws is logged and dropped; the queue keeps running.

export interface ApplyQueue {
  /** Queue a batch behind everything already queued. Never throws. */
  enqueue: (batch: unknown[]) => void
  /** Resolves when the queue drains — tests only. */
  idle: () => Promise<void>
}

export function createApplyQueue(
  apply: (batch: unknown[]) => Promise<void>,
  onError: (err: unknown) => void = () => {},
): ApplyQueue {
  let chain: Promise<void> = Promise.resolve()
  return {
    enqueue(batch) {
      chain = chain
        // Heal a chain poisoned by an earlier batch before adding ours.
        .catch(() => {})
        .then(() => apply(batch))
        .catch(onError)
    },
    idle() {
      return chain.catch(() => {})
    },
  }
}
