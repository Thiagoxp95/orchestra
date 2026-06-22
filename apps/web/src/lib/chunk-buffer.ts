export type Chunk = { seq: number; data: string }

export function nextChunks(
  chunks: Chunk[],
  afterSeq: number,
): { data: string; afterSeq: number } {
  const fresh = chunks
    .filter((c) => c.seq > afterSeq)
    .sort((a, b) => a.seq - b.seq)
  let data = ''
  let seen = afterSeq
  for (const c of fresh) {
    if (c.seq <= seen) continue // dedupe
    data += c.data
    seen = c.seq
  }
  return { data, afterSeq: seen }
}
