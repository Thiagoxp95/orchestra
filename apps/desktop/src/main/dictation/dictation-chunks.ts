// Pure helpers for assembling dictation audio chunks pulled from Convex. The
// orchestrator polls getDictationChunks(afterSeq); rows can arrive out of order
// or duplicated across overlapping polls, so we sort + de-dup before feeding the
// sidecar in strict seq order.

export interface RawChunk {
  seq: number
  pcm: string
}

export function orderChunks(rows: RawChunk[], afterSeq: number): RawChunk[] {
  const bySeq = new Map<number, RawChunk>()
  for (const r of rows) {
    if (r.seq > afterSeq && !bySeq.has(r.seq)) bySeq.set(r.seq, r)
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

export function maxSeq(rows: RawChunk[], fallback: number): number {
  let m = fallback
  for (const r of rows) if (r.seq > m) m = r.seq
  return m
}
