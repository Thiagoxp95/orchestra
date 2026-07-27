// Keeping the PTY chunk stream flowing across a cursor change.
//
// The web reads output with getChunks(sessionId, afterSeq), and afterSeq is a
// query ARGUMENT — so advancing it is not an update to a subscription, it is a
// different subscription. The new one delivers nothing until its registration
// has crossed the network and come back, and on a phone that round trip is
// longer than the interval the bridge flushes chunks at. With one cursor that
// dead time lands between every batch and the next, so the mirror can only
// repaint about once per round trip no matter how fast the desktop is painting:
// output arrives in lumps instead of a stream, which is what scrolling a TUI
// from the phone feels like when it stutters.
//
// Two cursors fix it by never moving both off a live subscription at once. One
// slot carries the batch; the other stays where it is, still registered, still
// delivering, and covers the round trip its partner spends re-registering. They
// leapfrog, so neither drifts far behind.

export interface CursorPair {
  a: number
  b: number
}

/** A slot as of this render: whether its subscription has delivered at its
 *  current cursor, and how many bytes that cursor is currently costing us. */
export interface SlotState {
  live: boolean
  bytes: number
}

/**
 * Where the two cursors should sit now that `consumed` has been written to xterm.
 *
 * Advances at most one slot — the one further behind — and only while its
 * partner is live, because moving the last registered cursor reopens exactly the
 * gap the pair exists to close.
 *
 * `maxOverlapBytes` is the escape hatch. A trailing cursor re-sends everything
 * since itself on every update, so an overlap held open through a firehose (a
 * build log, a `cat` of something enormous) costs real bandwidth on a phone —
 * and a partner that never comes back would hold it open forever. Past that
 * ceiling the trailing slot advances regardless: the stream degrades to
 * single-cursor behaviour, which is the right trade when the link is the
 * bottleneck rather than the round trip.
 */
export function advanceCursors(
  cursors: CursorPair,
  consumed: number,
  a: SlotState,
  b: SlotState,
  maxOverlapBytes: number,
): CursorPair {
  if (consumed <= cursors.a && consumed <= cursors.b) return cursors
  const lagA = consumed - cursors.a
  const lagB = consumed - cursors.b
  // Ties go to A so the pair still leapfrogs from a cold start, where both
  // cursors are -1 and neither is behind the other.
  const moveA = lagA >= lagB
  // Landing both slots on the same seq makes them the same query at the same
  // args — which Convex serves as ONE subscription, putting us straight back to
  // the single-cursor stall. Leave the partner where it is instead; it is
  // already at the head, so nothing is being missed by waiting a batch.
  if (moveA) {
    if (cursors.b === consumed) return cursors
    return b.live || a.bytes > maxOverlapBytes ? { ...cursors, a: consumed } : cursors
  }
  if (cursors.a === consumed) return cursors
  return a.live || b.bytes > maxOverlapBytes ? { ...cursors, b: consumed } : cursors
}

/** Bytes a slot is currently carrying — its cost of being held back. */
export function slotBytes(chunks: { data: string }[] | undefined): number {
  if (!chunks) return 0
  let n = 0
  for (const c of chunks) n += c.data.length
  return n
}
