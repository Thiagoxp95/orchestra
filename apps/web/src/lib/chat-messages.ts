// Pure logic for the structured chat mirror (see components/ChatPane.tsx).
//
// The desktop parses agent transcripts into ChatMessages and appends them to
// Convex under a per-session monotonic seq (same invariant as the PTY chunk
// stream); the web reads them back as a cursor stream plus one-shot backfill
// pages. Everything that can be wrong about assembling that into a readable
// conversation — merging pages with the live tail, pairing tool results back
// onto their calls, keeping an optimistic echo honest — lives here, free of
// React and Convex, so it can be unit-tested like the rest of src/lib.

// ── Wire model ───────────────────────────────────────────────────────────────
// Duplicated per app (the repo has no shared package); must stay in lockstep
// with apps/desktop/src/main/agent-message-model.ts and the backend's
// agentMessages table. Sizes are capped by the desktop parser, so nothing here
// re-truncates.

export type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  // A tool invocation. `input` is a compact human summary (e.g. the command
  // line, the file path), not raw JSON. `id` pairs it with a later result.
  | { kind: 'tool'; id?: string; name: string; input: string }
  // A tool result. `forId` pairs it back to the call; unmatched results render
  // standalone.
  | { kind: 'toolResult'; forId?: string; output: string; isError?: boolean }
  | { kind: 'image'; alt?: string }

export type ChatMessage = {
  uid: string // stable identity: Claude record uuid; Codex `<fileBase>:<lineNo>`
  role: 'user' | 'assistant' | 'tool' | 'system'
  blocks: ChatBlock[]
  ts?: number // ms epoch from the transcript timestamp, when present
}

/** A mirrored row: the message plus the per-session seq it is stored under. */
export type SeqChatMessage = ChatMessage & { seq: number }

// ── Merging ──────────────────────────────────────────────────────────────────

/**
 * Fold a batch of rows (a backfill page, or the live tail) into the held list.
 * Identity is the uid, and the later copy wins — the desktop re-pushes a
 * message when a resume replay or tailer restart re-parses it, and the
 * re-push may carry amended blocks (the backend patches in place, keeping the
 * stored seq). Order is the seq, which is the order the desktop appended in;
 * uid breaks ties only so the sort is deterministic. Returns `prev` untouched
 * when the batch adds nothing, so React sees a stable reference.
 */
export function mergeMessages(prev: SeqChatMessage[], incoming: SeqChatMessage[]): SeqChatMessage[] {
  if (incoming.length === 0) return prev
  const byUid = new Map<string, SeqChatMessage>()
  for (const m of prev) byUid.set(m.uid, m)
  for (const m of incoming) byUid.set(m.uid, m)
  return [...byUid.values()].sort(
    (a, b) => a.seq - b.seq || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0),
  )
}

// ── Display folding ──────────────────────────────────────────────────────────

export type ToolResultDisplay = { output: string; isError?: boolean }

/**
 * ChatBlock, with tool calls widened to carry the result that answered them.
 * The unmatched `toolResult` variant survives so a result whose call fell off
 * the retention window (or arrived out of order) still renders standalone.
 */
export type DisplayBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id?: string; name: string; input: string; result?: ToolResultDisplay }
  | { kind: 'toolResult'; forId?: string; output: string; isError?: boolean }
  | { kind: 'image'; alt?: string }

export type DisplayItem = {
  uid: string
  role: ChatMessage['role']
  blocks: DisplayBlock[]
  ts?: number
}

/**
 * Turn the merged message list into what the pane actually draws. Transcripts
 * store a tool call (assistant message) and its result (a separate role 'tool'
 * message) as two records, but the reader wants one row: the call, expandable
 * to its output. So role 'tool' messages are folded INTO the preceding
 * assistant message's matching tool block (toolResult.forId → tool.id).
 *
 * The scan for the matching call walks backwards through everything already
 * emitted, not just the immediately preceding item — tool ids are globally
 * unique, and an agent that fires several calls before their results land
 * interleaves the two roles. A result whose call can't be found (pruned by the
 * retention cap, or garbage) keeps its own item rather than being dropped:
 * losing an error output because its call scrolled away would be worse than an
 * orphan row. A call that already holds a result never takes a second one —
 * the duplicate renders standalone, where it is at least visible.
 *
 * Consecutive assistant messages within a turn stay separate items (no
 * merging). Input messages are never mutated; tool blocks are copied before
 * results are attached.
 */
export function foldForDisplay(messages: ChatMessage[]): DisplayItem[] {
  const items: DisplayItem[] = []
  for (const m of messages) {
    if (m.role !== 'tool') {
      items.push({
        uid: m.uid,
        role: m.role,
        ts: m.ts,
        blocks: m.blocks.map((b) => (b.kind === 'tool' ? { ...b } : b)),
      })
      continue
    }
    const standalone: DisplayBlock[] = []
    for (const b of m.blocks) {
      if (b.kind !== 'toolResult') {
        standalone.push(b)
        continue
      }
      const slot = b.forId ? findOpenToolBlock(items, b.forId) : null
      if (slot) slot.result = { output: b.output, isError: b.isError }
      else standalone.push(b)
    }
    if (standalone.length > 0) items.push({ uid: m.uid, role: 'tool', ts: m.ts, blocks: standalone })
  }
  return items
}

/** The most recent assistant tool block with this id that has no result yet. */
function findOpenToolBlock(
  items: DisplayItem[],
  forId: string,
): Extract<DisplayBlock, { kind: 'tool' }> | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.role !== 'assistant') continue
    for (const b of item.blocks) {
      if (b.kind === 'tool' && b.id === forId && !b.result) return b
    }
  }
  return null
}

// ── Optimistic echo ──────────────────────────────────────────────────────────

/**
 * The message the pane shows the instant a send fires, before the round trip
 * through the PTY → transcript → desktop parser → Convex brings the real copy
 * back. `headSeq` is the highest real seq known at send time: any genuine
 * role 'user' message that lands above it is the transcript's own record of
 * (some) send, at which point the echo has served its purpose.
 */
export type PendingEcho = { headSeq: number; message: SeqChatMessage }

export function makeEcho(text: string, headSeq: number, nonce: string, ts = Date.now()): PendingEcho {
  return {
    headSeq,
    message: {
      // `local:` namespaces the uid away from transcript uuids, and doubles as
      // the pane's "render this dimmed, it's pending" marker.
      uid: `local:${nonce}`,
      role: 'user',
      blocks: [{ kind: 'text', text }],
      // Sorts after every real seq, so an echo that is ever merged into the
      // real list (it shouldn't be — the pane appends echoes separately) still
      // lands at the tail instead of somewhere mid-history.
      seq: Number.MAX_SAFE_INTEGER,
      ts,
    },
  }
}

/**
 * Drop each echo once a real role 'user' message with a seq above its
 * send-time head has arrived. Matching by content would be wrong — the
 * transcript's copy is wrapped/reworded by the harness — so arrival order is
 * the signal: the transcript records sends in order, and a user message newer
 * than the send can only mean the send (or something after it) got through.
 * Returns the same array when nothing was pruned, so React sees a stable
 * reference.
 */
export function pruneEchoes(echoes: PendingEcho[], incoming: SeqChatMessage[]): PendingEcho[] {
  if (echoes.length === 0) return echoes
  const pruned = echoes.filter(
    (e) => !incoming.some((m) => m.role === 'user' && m.seq > e.headSeq),
  )
  return pruned.length === echoes.length ? echoes : pruned
}

// ── Fenced-code splitting ────────────────────────────────────────────────────

export type TextSegment = { code: boolean; text: string; lang?: string }

/**
 * Split assistant text on ``` fences so the pane can style code without a
 * markdown dependency (v1 renders everything else as plain text). Line-based:
 * a line whose content starts with ``` toggles code mode, with the opener's
 * remainder taken as the language tag. An unclosed fence runs to the end —
 * truncated messages (the desktop caps text mid-message) must not flip the
 * rest of the conversation into code styling, and per-message splitting
 * contains the damage to the message that was cut.
 */
export function splitFences(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let buf: string[] = []
  let inCode = false
  let lang: string | undefined
  const flush = () => {
    const t = buf.join('\n')
    buf = []
    if (t.length === 0) return
    segments.push(inCode ? { code: true, text: t, lang } : { code: false, text: t })
  }
  for (const line of text.split('\n')) {
    const m = /^\s*```(.*)$/.exec(line)
    if (!m) {
      buf.push(line)
      continue
    }
    flush()
    inCode = !inCode
    lang = inCode ? m[1].trim() || undefined : undefined
  }
  flush()
  return segments
}
