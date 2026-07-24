// Pure decision helper for the orchestrator: when has the desktop consumed
// everything the phone sent, so the sidecar can be asked to transcribe?
// Kept out of dictation-orchestrator.ts so it unit-tests without dragging in
// Electron (same reason dictation-chunks.ts lives separately).

// How long to keep waiting for the last chunks after the phone released the
// button. The phone only ends once its uploads are acknowledged, so this is
// purely a backstop for Convex read lag or a client that died mid-upload.
export const DRAIN_GRACE_MS = 4_000

export interface DrainState {
  ended: boolean           // phone released the button
  expected: number | null  // chunkCount reported with endDictation
  received: number         // distinct chunks fed to the sidecar
  endedAt: number | null   // when 'ended' was first observed
}

/**
 * True once every chunk the phone said it uploaded has been fed to the sidecar.
 *
 * Falling back to "this poll returned nothing new" is what used to truncate the
 * tail of an utterance: an empty poll only means the read didn't see the rows
 * yet, not that the phone has stopped sending. Clients that report a chunkCount
 * get an exact drain; older ones keep the best-effort behaviour.
 */
export function shouldFinalize(d: DrainState, freshChunks: number, now: number): boolean {
  if (!d.ended) return false
  if (d.expected !== null) {
    if (d.received >= d.expected) return true
  } else if (freshChunks === 0) {
    return true
  }
  // Backstop: the phone died mid-upload, or a chunk was lost for good.
  return d.endedAt !== null && now - d.endedAt >= DRAIN_GRACE_MS
}
