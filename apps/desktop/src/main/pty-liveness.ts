/**
 * Which mirrored sessions still have a live PTY behind them.
 *
 * The daemon owns every PTY, and it can die (reboot, crash) taking all of them
 * with it while the renderer store — and therefore the phone mirror — keeps
 * listing the sessions under their last processStatus. Those corpses look like
 * live agent sessions from the phone, and daemon.write() is fire-and-forget,
 * so keystrokes, chat sends and picker switches typed into one vanish with no
 * error anywhere. This tracker compares the store's session list against the
 * daemon's on a slow poll and calls a session dead once its PTY has been
 * missing long enough to rule out races; the verdict rides the existing
 * liveStatus `exited` flag the web already renders, and gates bridge writes.
 *
 * The grace window exists because "not in listSessions" is also what a newborn
 * looks like in the moment between the renderer adding it to the store and
 * terminal-create reaching the daemon — a fresh session must never flash as
 * exited. Poll failures must feed nothing: a broken daemon socket is signal
 * loss, not evidence that every agent died (the same lesson as
 * process-monitor's ps snapshot).
 */

export const PTY_DEAD_GRACE_MS = 15_000

export interface DaemonSessionLike {
  sessionId: string
  isAlive: boolean
}

export class PtyLiveness {
  /** When each store session was first seen missing from (or dead in) the daemon. */
  private absentSince = new Map<string, number>()
  /** Sessions currently judged dead. */
  private verdicts = new Set<string>()

  /**
   * Feed one successful listSessions poll. Returns the ids whose verdict
   * flipped — dead, or back alive after the desktop reopened the session —
   * so the caller can update liveStatus and re-push the mirror once.
   */
  update(
    daemonSessions: DaemonSessionLike[],
    storeSessionIds: string[],
    now: number,
  ): string[] {
    const owned = new Set<string>()
    for (const s of daemonSessions) if (s.isAlive) owned.add(s.sessionId)
    // Sessions closed on the desktop leave the store; drop their bookkeeping so
    // a reused id ever after starts from a clean slate.
    const store = new Set(storeSessionIds)
    for (const id of [...this.absentSince.keys()]) if (!store.has(id)) this.absentSince.delete(id)
    for (const id of [...this.verdicts]) if (!store.has(id)) this.verdicts.delete(id)

    const changed: string[] = []
    for (const id of storeSessionIds) {
      if (owned.has(id)) {
        this.absentSince.delete(id)
        if (this.verdicts.delete(id)) changed.push(id)
      } else {
        const since = this.absentSince.get(id)
        if (since === undefined) {
          this.absentSince.set(id, now)
        } else if (!this.verdicts.has(id) && now - since >= PTY_DEAD_GRACE_MS) {
          this.verdicts.add(id)
          changed.push(id)
        }
      }
    }
    return changed
  }

  /** Confirmed-gone PTY? Conservative: false until enough polls said so. */
  isDead(id: string): boolean {
    return this.verdicts.has(id)
  }
}
