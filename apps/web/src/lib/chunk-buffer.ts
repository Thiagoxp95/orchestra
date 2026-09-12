export type Chunk = { seq: number; data: string; seed?: boolean }

/**
 * Fold the chunks newer than `afterSeq` into a single write for xterm.
 *
 * A chunk flagged `seed` is the full-screen snapshot that opens a (re)attach.
 * When one appears we drop everything accumulated before it and signal `reset`,
 * so the caller resets xterm and the seed repaints from a clean slate instead
 * of layering onto stale content. This is how a re-seed (a second viewer, a
 * desktop wake re-seed, a respawn) recovers a frozen mirror without a remount:
 * the seed lands above the cursor (seq is monotonic on the bridge), so it's
 * delivered and the terminal repaints. The last seed in the batch wins.
 */
export function nextChunks(
  chunks: Chunk[],
  afterSeq: number,
): { data: string; afterSeq: number; reset: boolean; needsSeed?: boolean } {
  const fresh = chunks
    .filter((c) => c.seq > afterSeq)
    .sort((a, b) => a.seq - b.seq)
  let data = ''
  let seen = afterSeq
  let reset = false
  let gap = false
  for (const c of fresh) {
    if (c.seq <= seen) continue // dedupe
    if (c.seed) {
      reset = true
      gap = false
      data = '' // a seed is a full repaint; discard any pre-seed bytes
    } else if (seen < 0 || c.seq !== seen + 1) {
      // Retention can remove the initial snapshot or output while a phone is
      // asleep. Relative cursor updates cannot reconstruct the missing screen.
      gap = true
    }
    data += c.data
    seen = c.seq
  }
  if (gap) return { data: '', afterSeq, reset: false, needsSeed: true }
  return { data, afterSeq: seen, reset }
}
