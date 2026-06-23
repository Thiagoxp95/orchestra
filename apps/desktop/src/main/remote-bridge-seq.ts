// Monotonic per-session sequence numbers for mirrored PTY chunks.
//
// The web's read cursor (`afterSeq` in Terminal.tsx) only ever climbs, and the
// backend's getChunks filters `seq > afterSeq`. So if the desktop ever reset a
// session's seq back to 0 (the old behaviour on every re-attach), the freshly
// seeded chunks would all land at seq <= a still-watching client's cursor, and
// getChunks would return [] for that client forever — a permanent freeze that
// only a full PWA remount (which resets afterSeq to -1) could clear. That was
// the "stuck terminal, have to close and reopen" bug.
//
// ChunkSeq guarantees seq is strictly increasing per session for the lifetime
// of the bridge process, AND can be primed from the highest seq already stored
// in Convex (see `init`) so the invariant also survives a desktop restart. A
// re-seed therefore always appends ABOVE every client's cursor, so every viewer
// — old or new — receives it and repaints.
export class ChunkSeq {
  private readonly nextBySession = new Map<string, number>()

  /** Whether this session's counter is already being tracked in-process. */
  has(sessionId: string): boolean {
    return this.nextBySession.has(sessionId)
  }

  /**
   * Prime a session's counter from the persisted head (the max seq already in
   * Convex, or -1 if none) so seq continues monotonically across a desktop
   * restart. No-op once the session is tracked: in-process monotonicity always
   * wins, and we must never lower a counter we've already handed out.
   */
  init(sessionId: string, headSeq: number): void {
    if (this.nextBySession.has(sessionId)) return
    this.nextBySession.set(sessionId, headSeq + 1)
  }

  /** Allocate the next seq for a session (monotonic; never resets to 0). */
  next(sessionId: string): number {
    const seq = this.nextBySession.get(sessionId) ?? 0
    this.nextBySession.set(sessionId, seq + 1)
    return seq
  }
}
