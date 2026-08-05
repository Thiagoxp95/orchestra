// Serialized, self-healing, latest-wins queue for applying pending-command
// snapshots.
//
// Two invariants, learned the hard way:
//
// 1. Snapshots must not interleave: applying one can take seconds (a paced key
//    sequence typed into a TUI), and a subscription update landing mid-sequence
//    must not start draining the next snapshot into the same PTY on top of it.
//
// 2. A failure must not stop the queue. The naive serialization —
//    `chain = chain.then(() => apply(batch))` — shipped in v1.21.28 and killed
//    EVERY phone→desktop command until app restart: once any batch rejects, the
//    chain holds a rejected promise and every later `.then()` short-circuits
//    forever, silently.
//
// Latest-wins (v1.21.31): each enqueue carries the FULL pending list, so a
// snapshot that arrives while another waits makes the waiting one redundant —
// every command it holds is either in the newer snapshot too or already
// deleted. Replacing instead of chaining keeps a backlog from forming at all:
// in the v1.21.30 spawn storm, ~60 snapshots queued up behind a slow command
// and took a minute+ to drain, re-applying their contents as they went.

export interface ApplyQueue {
  /** Queue a snapshot, replacing any snapshot still waiting. Never throws. */
  enqueue: (batch: unknown[]) => void
  /** Resolves when the queue drains — tests only. */
  idle: () => Promise<void>
}

export function createApplyQueue(
  apply: (batch: unknown[]) => Promise<void>,
  onError: (err: unknown) => void = () => {},
): ApplyQueue {
  let queued: unknown[] | null = null
  let running: Promise<void> | null = null

  const pump = async (): Promise<void> => {
    while (queued) {
      const batch = queued
      queued = null
      try {
        await apply(batch)
      } catch (err) {
        try {
          onError(err)
        } catch {
          /* a throwing error handler must not kill the pump */
        }
      }
    }
  }

  // The pump owns `running`: it clears the slot itself and re-starts if a
  // snapshot slipped in between its last queued-check and the clear (possible
  // when apply completes synchronously). Assigning pump's promise from enqueue
  // instead would overwrite that clear and wedge idle() forever.
  const start = (): void => {
    if (running) return
    running = pump().then(() => {
      running = null
      if (queued) start()
    })
  }

  return {
    enqueue(batch) {
      queued = batch
      start()
    },
    async idle() {
      while (running) await running
    },
  }
}
