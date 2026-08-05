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
  /** Apply one snapshot of the pending list, oldest first. Never rejects. */
  drain: (commands: unknown[]) => Promise<void>
}

export function createCommandDrain(
  apply: (cmd: DrainedCommand) => Promise<void>,
  ack: (id: string) => Promise<void>,
  onError: (context: string, err: unknown) => void = (context, err) => console.error(context, err),
): CommandDrain {
  // Commands already applied. An entry must OUTLIVE its ack: dropping it as soon
  // as the delete settles is what let stale queued snapshots re-apply the same
  // command. `acked: false` means the delete itself failed — the row is still in
  // the table, so later snapshots retry the ack (never the apply).
  const handled = new Map<string, { acked: boolean }>()

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
      for (const id of [...handled.keys()]) if (!live.has(id)) handled.delete(id)

      for (const raw of commands) {
        const cmd = raw as DrainedCommand
        const id = typeof cmd?._id === 'string' ? cmd._id : ''
        if (!id) continue
        const prior = handled.get(id)
        if (prior?.acked) continue
        if (!prior) {
          handled.set(id, { acked: false })
          try {
            await apply(cmd)
          } catch (err) {
            onError(`command failed: ${String(cmd.kind ?? '?')}`, err)
          }
        }
        try {
          await ack(id)
          handled.get(id)!.acked = true
        } catch (err) {
          onError('deleteCommand failed', err)
        }
      }
    },
  }
}
