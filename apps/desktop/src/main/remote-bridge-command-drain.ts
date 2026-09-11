// Applies one snapshot of the pending-command list, exactly once per command.
//
// The command subscription (remote.pendingCommands) delivers the FULL pending
// list every time the table changes, and those snapshots queue up behind
// whatever the apply queue is currently doing. A snapshot captured before a
// command's delete committed still contains that command — so the dedup guard
// here is what stands between "one tap on the phone" and "one Claude session
// per queued snapshot" (the v1.21.30 spawn storm: a spawnInTree rode ~60
// backlogged snapshots and spawned a session per second while they drained).
//
// Kept free of Electron/Convex imports so it is unit-testable, like the other
// bridge helpers.

export interface DrainedCommand {
  _id: string
  kind?: string
  [key: string]: unknown
}

export interface CommandDrain {
  /** Apply oldest first; cloud acknowledgements drain independently. Never rejects. */
  drain: (commands: unknown[]) => Promise<void>
}

// Nothing in this pipeline may wait forever. The apply queue runs snapshots one
// at a time behind whatever the current one is doing, so a single promise that
// never settles wedges EVERY later phone→desktop command until app restart —
// which is exactly what happened on 2026-08-16: a wifi drop tripped the push
// watchdog, recreateClient() closed the socket out from under an in-flight
// deleteCommand mutation, that mutation's promise never settled, and for the
// next 20+ minutes attach/spawn/claimGeometry piled up unapplied (blank terminal,
// "tapping a branch does nothing") while the state push looked perfectly healthy.
//
// The apply cap is generous because a legitimate apply can be slow: a paced key
// sequence, a sendChatMessage that downloads photos then waits out two settles.
// The ack cap is short: a delete is one round-trip, and if it has not settled by
// then the socket is gone and the row will be re-acked from the next snapshot.
export const APPLY_TIMEOUT_MS = 90_000
export const ACK_TIMEOUT_MS = 15_000

/** Reject with `label` if `p` has not settled within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, bomb]).finally(() => clearTimeout(timer)) as Promise<T>
}

export function createCommandDrain(
  apply: (cmd: DrainedCommand) => Promise<void>,
  ack: (id: string) => Promise<void>,
  onError: (context: string, err: unknown) => void = (context, err) => console.error(context, err),
  timeouts: { applyMs?: number; ackMs?: number; maxConcurrentAcks?: number } = {},
): CommandDrain {
  const applyMs = timeouts.applyMs ?? APPLY_TIMEOUT_MS
  const ackMs = timeouts.ackMs ?? ACK_TIMEOUT_MS
  // Commands already applied. An entry must OUTLIVE its ack: dropping it as soon
  // as the delete settles is what let stale queued snapshots re-apply the same
  // command. `acked: false` means the delete itself failed — the row is still in
  // the table, so later snapshots retry the ack (never the apply).
  type Handled = { acked: boolean; acking: boolean }
  const handled = new Map<string, Handled>()
  const pendingAcks = new Map<string, Handled>()
  const maxConcurrentAcks = Math.max(1, timeouts.maxConcurrentAcks ?? 8)
  let activeAcks = 0

  // Deleting a row is bookkeeping, not permission to apply the next key. Waiting
  // for that round trip here used to space a burst of keystrokes one RTT apart.
  // Keep dedupe records across in-flight deletes and bound socket work separately.
  const pumpAcks = () => {
    while (activeAcks < maxConcurrentAcks && pendingAcks.size) {
      const [id, entry] = pendingAcks.entries().next().value!
      pendingAcks.delete(id)
      if (handled.get(id) !== entry || entry.acked || entry.acking) continue
      entry.acking = true
      activeAcks++
      void withTimeout(Promise.resolve().then(() => ack(id)), ackMs, 'deleteCommand')
        .then(() => { entry.acked = true }, err => { onError('deleteCommand failed', err) })
        .finally(() => {
          entry.acking = false
          activeAcks--
          pumpAcks()
        })
    }
  }

  return {
    async drain(commands: unknown[]): Promise<void> {
      if (!Array.isArray(commands)) return
      // This snapshot is the newest truth: an id absent from it was deleted
      // server-side and can never be delivered again, so its guard entry can go.
      // Snapshots arrive (and are queued) in delivery order, which is monotonic
      // in the query's version — a later drain never sees an older snapshot.
      const live = new Set<string>()
      for (const raw of commands) {
        const id = (raw as DrainedCommand | null)?._id
        if (typeof id === 'string' && id) live.add(id)
      }
      for (const id of [...handled.keys()]) if (!live.has(id)) {
        handled.delete(id)
        pendingAcks.delete(id)
      }

      for (const raw of commands) {
        const cmd = raw as DrainedCommand
        const id = typeof cmd?._id === 'string' ? cmd._id : ''
        if (!id) continue
        const prior = handled.get(id)
        if (prior?.acked) continue
        if (!prior) {
          handled.set(id, { acked: false, acking: false })
          try {
            await withTimeout(apply(cmd), applyMs, `apply ${String(cmd.kind ?? '?')}`)
          } catch (err) {
            onError(`command failed: ${String(cmd.kind ?? '?')}`, err)
          }
        }
        const entry = handled.get(id)!
        if (!entry.acked && !entry.acking) pendingAcks.set(id, entry)
        pumpAcks()
      }
    },
  }
}
