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

export type QuestionOption = { label: string; description?: string }
export type QuestionSpec = {
  question: string
  /** Any option had a `preview`, which changes the TUI form's shape and so the
   *  keys that answer it. Mirrored by the desktop parser; see
   *  buildQuestionKeySequence. */
  hasPreview?: boolean
  header?: string
  multiSelect?: boolean
  options: QuestionOption[]
}

export type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  // A tool invocation. `input` is a compact human summary (e.g. the command
  // line, the file path), not raw JSON. `id` pairs it with a later result.
  | { kind: 'tool'; id?: string; name: string; input: string }
  // An AskUserQuestion form, mirrored structured so this pane can render (and
  // answer) the real TUI form. `id` pairs it with the result like a tool block.
  | { kind: 'question'; id?: string; questions: QuestionSpec[] }
  // A tool result. `forId` pairs it back to the call; unmatched results render
  // standalone. `answers` is AskUserQuestion's structured question→choice map.
  | { kind: 'toolResult'; forId?: string; output: string; isError?: boolean; answers?: Record<string, string> }
  | { kind: 'image'; alt?: string }
  // A conversation cut, synthesized by the desktop mirror when a session's
  // transcript swaps to a different file (a fresh conversation in the same
  // pane). Everything stored before it was cleared server-side; the pane drops
  // everything it holds before it too (cutAtReset) and renders nothing for the
  // marker itself.
  | { kind: 'reset' }

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

/**
 * Everything after the newest reset marker — the pane's view of a conversation
 * swap. The desktop clears the stored rows when a session's transcript swaps
 * to a different conversation, but this pane holds its own copy of what it
 * already rendered, and a server-side delete never reaches local state. The
 * marker does — in seq order, through the same live tail as every other row —
 * so cutting at it is race-free where inferring the delete from row queries is
 * not (Convex can coalesce the delete and the new conversation's first rows
 * into one update). The marker itself is dropped too: it renders as nothing.
 */
export function cutAtReset<T extends ChatMessage>(messages: T[]): T[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'system' && m.blocks.some((b) => b.kind === 'reset')) {
      return messages.slice(i + 1)
    }
  }
  return messages
}

// ── Display folding ──────────────────────────────────────────────────────────

export type ToolResultDisplay = { output: string; isError?: boolean; answers?: Record<string, string> }

/**
 * ChatBlock, with tool calls widened to carry the result that answered them.
 * The unmatched `toolResult` variant survives so a result whose call fell off
 * the retention window (or arrived out of order) still renders standalone.
 */
export type DisplayBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id?: string; name: string; input: string; result?: ToolResultDisplay }
  | { kind: 'question'; id?: string; questions: QuestionSpec[]; result?: ToolResultDisplay }
  | { kind: 'toolResult'; forId?: string; output: string; isError?: boolean; answers?: Record<string, string> }
  | { kind: 'image'; alt?: string }
  // Never reaches the pane in practice — cutAtReset drops the marker before
  // folding — but the fold stays total over ChatBlock.
  | { kind: 'reset' }

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
        blocks: m.blocks.map((b) => (b.kind === 'tool' || b.kind === 'question' ? { ...b } : b)),
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
      if (slot) slot.result = { output: b.output, isError: b.isError, answers: b.answers }
      else standalone.push(b)
    }
    if (standalone.length > 0) items.push({ uid: m.uid, role: 'tool', ts: m.ts, blocks: standalone })
  }
  return items
}

/** The most recent assistant tool/question block with this id and no result yet. */
function findOpenToolBlock(
  items: DisplayItem[],
  forId: string,
): Extract<DisplayBlock, { kind: 'tool' } | { kind: 'question' }> | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.role !== 'assistant') continue
    for (const b of item.blocks) {
      if ((b.kind === 'tool' || b.kind === 'question') && b.id === forId && !b.result) return b
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

export function makeEcho(
  text: string,
  headSeq: number,
  nonce: string,
  ts = Date.now(),
  imageCount = 0,
): PendingEcho {
  // Images lead the text, matching the order the desktop types them into the
  // TUI (paths first, then the message).
  const blocks: ChatBlock[] = Array.from({ length: imageCount }, () => ({ kind: 'image' as const }))
  if (text) blocks.push({ kind: 'text', text })
  return {
    headSeq,
    message: {
      // `local:` namespaces the uid away from transcript uuids, and doubles as
      // the pane's "render this dimmed, it's pending" marker.
      uid: `local:${nonce}`,
      role: 'user',
      blocks,
      // Sorts after every real seq, so an echo that is ever merged into the
      // real list (it shouldn't be — the pane appends echoes separately) still
      // lands at the tail instead of somewhere mid-history.
      seq: Number.MAX_SAFE_INTEGER,
      ts,
    },
  }
}

// ── User-bubble image chips ──────────────────────────────────────────────────

// The absolute paths the desktop types for phone-attached images, plus the
// "[Image #N]" placeholder claude-code substitutes when it ingests a pasted
// image. Either way the raw text is noise in a chat bubble — the pane swaps
// each match for a compact image chip.
const USER_IMAGE_TOKEN_RE = /\S*\/\.orchestra\/remote-images\/\S+|\[Image #\d+\]/g

/** Strip image path/placeholder tokens out of user text, counting them. */
export function splitUserImageTokens(text: string): { text: string; imageCount: number } {
  let imageCount = 0
  const stripped = text.replace(USER_IMAGE_TOKEN_RE, () => {
    imageCount++
    return ''
  })
  return { text: stripped.replace(/[ \t]{2,}/g, ' ').trim(), imageCount }
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

/**
 * Pair each echo about to be pruned with the real message that replaced it, so
 * the thumbnails the echo was showing can move onto the transcript's copy.
 *
 * Without this the attached image visibly *disappears* a second after sending:
 * the echo renders real thumbnails from the picker's object URLs, and the
 * mirrored copy that lands in its place carries only the desktop-side path the
 * bridge typed into the TUI (`~/.orchestra/remote-images/…`), which no browser
 * can load — so the bubble collapses to the "image" chip and reads as a broken
 * attachment.
 *
 * Matching is by arrival order, exactly like pruneEchoes and for the same
 * reason: the transcript's copy is reworded by the harness, so content can't be
 * matched. Both lists are in send order, so the oldest echo owns the oldest user
 * message above its head, and each real message is claimed once.
 */
export function adoptEchoPreviews(
  echoes: PendingEcho[],
  incoming: SeqChatMessage[],
): { from: string; to: string }[] {
  if (echoes.length === 0) return []
  const users = incoming.filter((m) => m.role === 'user').sort((a, b) => a.seq - b.seq)
  if (users.length === 0) return []
  const claimed = new Set<string>()
  const pairs: { from: string; to: string }[] = []
  for (const echo of [...echoes].sort((a, b) => a.headSeq - b.headSeq)) {
    const match = users.find((m) => m.seq > echo.headSeq && !claimed.has(m.uid))
    if (!match) continue
    claimed.add(match.uid)
    pairs.push({ from: echo.message.uid, to: match.uid })
  }
  return pairs
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

// ── Answering the TUI question form ──────────────────────────────────────────
// The pending AskUserQuestion form is a live TUI on the desktop's PTY; the
// phone answers it by typing the same keys a person would.
//
// RE-VERIFIED live against claude-code 2.1.221 (drove real forms over a PTY and
// read the recorded answers back from the transcript). The protocol CHANGED
// from the 2.1.220 one this file used to encode, in ways that made the old
// sequence a silent no-op — it moved the cursor and never submitted:
//   - the form opens focused on option 1 of question 1, nothing selected
//   - a digit only MOVES FOCUS. It does not select and does not advance.
//     (Verified: pressing "2" on a 4-option form left the form up and recorded
//     nothing at all.) The footer says so: "Enter to select".
//   - Enter selects the focused option and advances to the next question; on
//     the last question it advances to a review tab whose Enter submits. A
//     single-question form submits on that first Enter, with no review tab.
//     Verified: ["2", Enter] → {"Which layout should I use?":"Top bar"};
//     ["2", Enter, "1", Enter, Enter] → {"Which language?":"Go","Which
//     tools?":"Lint"}.
//   - digits beyond the option count are IGNORED (verified: 5 and 6 on a
//     4-option form moved nothing), so the old options.length+2 "Chat about
//     this" key silently did nothing and the composer text then rained onto
//     the option list.
//   - form SHAPE decides the trailing rows. With previews the options render
//     beside a preview pane, there is no "Type something." row at all, and
//     "Chat about this" is unnumbered — reachable with ↓ × options.length.
//     Without previews both rows are numbered as before (options.length+1 and
//     options.length+2). Hence QuestionSpec.hasPreview.
//   - Esc cancels the whole form.
//
// Multi-select is NOT driven from here. Its keying did not reproduce reliably
// (digits appeared to toggle in one run and only move focus in another, and a
// full drive recorded one pick where two were asked for), and a mis-answered
// multi-select silently misreports a real decision. Those cards render
// read-only until the keying is pinned down; see QuestionCard.
//
// The sequence assumes the desktop form is untouched — its state is invisible
// from here, and the interactive card is only shown while the form is the
// conversation's live tail, which is also when nobody has interacted with it.

export type QuestionSelection = {
  /** 0-based indexes of the chosen options; exactly one for single-select. */
  optionIndexes: number[]
}

export type KeyStep = {
  data: string
  delayAfterMs: number
  /**
   * Send this step only when the session's terminal screen holds this phrase.
   * The desktop evaluates it (the phone can't see the screen) — used for TUI
   * confirmation dialogs that appear conditionally. Ignored by desktops older
   * than v1.21.29, which run the sequence unconditionally.
   */
  ifScreenContains?: string
}

const KEY_DELAY_MS = 250
// Enter both commits an answer and swaps the form to the next question, which
// is a full redraw — a digit sent too soon after it lands on the OLD question
// and is lost (observed: a pick dropped at 300ms and still dropped at 900ms).
const ADVANCE_DELAY_MS = 1_200
const DOWN_ARROW = '\x1b[B'

/** True when this form can be answered from the phone at all (see the
 *  multi-select note above). */
export function isDrivableQuestionForm(questions: QuestionSpec[]): boolean {
  return questions.length > 0 && questions.every((q) => !q.multiSelect && q.options.length > 0)
}

/**
 * The keystrokes that answer the whole form, or null when the selections are
 * incomplete (every question needs exactly one answer), out of range, or the
 * form isn't drivable. Pure so the protocol stays unit-testable; the pane feeds
 * the steps to the PTY writer with the given pacing.
 */
export function buildQuestionKeySequence(
  questions: QuestionSpec[],
  selections: QuestionSelection[],
): KeyStep[] | null {
  if (!isDrivableQuestionForm(questions)) return null
  if (selections.length !== questions.length) return null
  const steps: KeyStep[] = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const sel = selections[i]
    if (sel.optionIndexes.length !== 1) return null
    const idx = sel.optionIndexes[0]
    if (idx < 0 || idx >= q.options.length) return null
    steps.push({ data: String(idx + 1), delayAfterMs: KEY_DELAY_MS })
    // Commits this question and redraws the next one.
    steps.push({ data: '\r', delayAfterMs: ADVANCE_DELAY_MS })
  }
  // A multi-question form lands on the review tab, which needs its own Enter.
  // A single-question form has already submitted — a stray Enter there would
  // hit the composer.
  if (questions.length > 1) steps.push({ data: '\r', delayAfterMs: 0 })
  return steps
}

/**
 * The keys that pick "Chat about this" on the (still-focused) first question —
 * sent before a composer message while a form is pending, so the text lands as
 * a normal chat message instead of raining keystrokes onto the option list.
 * Rejects the tool use ("user wants to clarify") and returns the TUI to its
 * normal composer.
 */
export function chatAboutSteps(questions: QuestionSpec[]): KeyStep[] | null {
  const first = questions[0]
  if (!first || first.options.length === 0) return null
  const steps: KeyStep[] = []
  if (first.hasPreview) {
    // Unnumbered on preview forms: walk past the last option to reach it.
    for (let i = 0; i < first.options.length; i++) {
      steps.push({ data: DOWN_ARROW, delayAfterMs: KEY_DELAY_MS })
    }
  } else {
    steps.push({ data: String(first.options.length + 2), delayAfterMs: KEY_DELAY_MS })
  }
  steps.push({ data: '\r', delayAfterMs: ADVANCE_DELAY_MS })
  return steps
}

// ── Work-run folding ─────────────────────────────────────────────────────────
// A long agent turn is mostly tool calls and thinking — dozens of rows that
// bury the prose. Consecutive display items made ONLY of that (no text, no
// question) fold into a single expandable "Worked · N steps" row once enough
// of them pile up; while the turn is still running, the newest couple of rows
// stay visible (live progress) and only the older ones fold.

export type DisplayRow =
  | { kind: 'item'; item: DisplayItem }
  | {
      kind: 'work'
      /** Stable identity for expansion state: `work:` + first folded item's uid. */
      uid: string
      items: DisplayItem[]
      /** Total tool/thinking blocks folded away — the "N steps" label. */
      steps: number
      /** Still growing (turn running): label as "+N earlier steps", no check. */
      live: boolean
    }

// Fewer steps than this reads fine unfolded; folding it would just add a tap.
const MIN_FOLD_STEPS = 3
// While the turn runs, this many trailing work items stay visible as live rows.
const LIVE_TAIL_ITEMS = 2

function isWorkItem(item: DisplayItem): boolean {
  return (
    (item.role === 'assistant' || item.role === 'tool') &&
    item.blocks.length > 0 &&
    item.blocks.every((b) => b.kind === 'thinking' || b.kind === 'tool' || b.kind === 'toolResult')
  )
}

function countSteps(items: DisplayItem[]): number {
  return items.reduce(
    (n, it) =>
      n + it.blocks.filter((b) => b.kind === 'thinking' || b.kind === 'tool' || b.kind === 'toolResult').length,
    0,
  )
}

export function groupWork(display: DisplayItem[], working: boolean): DisplayRow[] {
  const rows: DisplayRow[] = []
  let run: DisplayItem[] = []
  const flush = (trailing: boolean) => {
    if (run.length === 0) return
    const atLiveTail = trailing && working
    const folded = atLiveTail ? run.slice(0, -LIVE_TAIL_ITEMS) : run
    const visible = atLiveTail ? run.slice(-LIVE_TAIL_ITEMS) : []
    if (countSteps(folded) >= MIN_FOLD_STEPS) {
      rows.push({
        kind: 'work',
        uid: `work:${folded[0].uid}`,
        items: folded,
        steps: countSteps(folded),
        live: atLiveTail,
      })
    } else {
      for (const item of folded) rows.push({ kind: 'item', item })
    }
    for (const item of visible) rows.push({ kind: 'item', item })
    run = []
  }
  for (const item of display) {
    if (isWorkItem(item)) {
      run.push(item)
      continue
    }
    flush(false)
    rows.push({ kind: 'item', item })
  }
  flush(true)
  return rows
}

// ── Model / reasoning-effort switching ───────────────────────────────────────
// The phone switches a LIVE session's model by typing the same things a person
// would into the TUI. Protocols verified empirically (2026-07-27):
//   - claude-code 2.1.220: `/model <alias>` and `/effort <level>` both accept
//     an argument, apply immediately, and print a confirmation; an unknown
//     value fails harmlessly ("Model 'x' not found").
//   - codex-cli 0.145.0: `/model` + Enter opens "Select Model and Effort";
//     digit N picks model row N and AUTO-ADVANCES to the effort list; digit
//     picks effort and applies ("Model changed to <model> <effort>"). Digit 5
//     on the effort list opens the Advanced Reasoning submenu (1 Max, 2 Ultra).
//     Esc backs out one level.

export type AgentKind = 'claude' | 'codex'

export type ModelOption = { value: string; label: string; hint?: string }

export const CLAUDE_MODELS: ModelOption[] = [
  { value: 'fable', label: 'Fable 5', hint: 'Most capable' },
  { value: 'opus', label: 'Opus', hint: 'Deep reasoning' },
  { value: 'sonnet', label: 'Sonnet', hint: 'Everyday work' },
  { value: 'haiku', label: 'Haiku 4.5', hint: 'Fast + light' },
]

export const CLAUDE_EFFORTS: ModelOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max', hint: 'Slowest, deepest' },
]

// value = the picker row digit (codex-cli 0.145.0 row order).
export const CODEX_MODELS: ModelOption[] = [
  { value: '1', label: 'gpt-5.6-sol', hint: 'Frontier coding' },
  { value: '2', label: 'gpt-5.6-terra', hint: 'Everyday work' },
  { value: '3', label: 'gpt-5.6-luna', hint: 'Fast + affordable' },
  { value: '4', label: 'gpt-5.5', hint: 'Complex work' },
  { value: '5', label: 'gpt-5.4', hint: 'Everyday coding' },
  { value: '6', label: 'gpt-5.4-mini', hint: 'Small + fast' },
]

// value = effort-list digits; "5,N" routes through the Advanced submenu.
export const CODEX_EFFORTS: ModelOption[] = [
  { value: '1', label: 'Low' },
  { value: '2', label: 'Medium' },
  { value: '3', label: 'High' },
  { value: '4', label: 'Extra high' },
  { value: '5,1', label: 'Max', hint: 'Higher usage' },
  { value: '5,2', label: 'Ultra', hint: 'Highest usage' },
]

/** A model/effort pair in picker-catalog values, every field optional. */
export type ModelSelection = { model?: string; effort?: string }

function catalogFor(agent: AgentKind): { models: ModelOption[]; efforts: ModelOption[] } {
  return agent === 'claude'
    ? { models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS }
    : { models: CODEX_MODELS, efforts: CODEX_EFFORTS }
}

/**
 * Map one raw transcript value onto its picker-catalog value, so the pill and
 * the sheet's checkmarks recognize it. Claude records full model ids
 * (`claude-fable-5`) where the picker holds aliases (`fable`), so the alias is
 * matched as a substring; codex records the display name itself (`gpt-5.6-sol`)
 * where the picker holds row digits, so labels are matched. Effort levels match
 * by value (claude) or label (codex), case-insensitively. An unrecognized raw
 * value is returned as-is — modelOptionLabel falls back to showing it verbatim,
 * which beats hiding a model this build's catalog hasn't heard of.
 */
function mapMirrored(agent: AgentKind, kind: 'model' | 'effort', raw?: string): string | undefined {
  if (!raw) return undefined
  const { models, efforts } = catalogFor(agent)
  const list = kind === 'model' ? models : efforts
  const lower = raw.toLowerCase()
  for (const o of list) {
    if (o.value.toLowerCase() === lower || o.label.toLowerCase() === lower) return o.value
    if (agent === 'claude' && kind === 'model' && lower.includes(o.value.toLowerCase())) return o.value
  }
  return raw
}

/**
 * What the pill (and the sheet's initial selection) should show as the
 * session's current model/effort.
 *
 * The mirrored transcript values are ground truth — they are what the agent
 * actually ran its last turn with, no matter where the switch happened — so
 * they win. The one gap is the turn right after this phone applies a switch:
 * the transcript keeps describing the pre-switch turn until the agent takes
 * another one. `local` bridges it: a locally-applied choice stays up as long as
 * the mirror still reports what it reported at apply time (`baseModel` /
 * `baseEffort`, stamped by the apply), and yields the moment the mirror moves.
 * Decided per field — claude switches model and effort independently.
 */
export function effectiveModelSelection(
  agent: AgentKind,
  local: ModelSelection & { baseModel?: string; baseEffort?: string },
  mirroredModel?: string,
  mirroredEffort?: string,
): ModelSelection {
  const pick = (
    kind: 'model' | 'effort',
    chosen?: string,
    base?: string,
    raw?: string,
  ): string | undefined => {
    if (chosen && raw === base) return chosen
    return mapMirrored(agent, kind, raw) ?? chosen
  }
  return {
    model: pick('model', local.model, local.baseModel, mirroredModel),
    effort: pick('effort', local.effort, local.baseEffort, mirroredEffort),
  }
}

// Clear, type, submit. The gap after the text lets the slash-command
// autocomplete close (with an argument typed it dismisses itself, so the CR
// submits the command instead of accepting a completion); the settle gap after
// the CR lets the TUI print its confirmation before the next command lands.
const SLASH_CLEAR_MS = 120
const SLASH_CR_DELAY_MS = 350
const SLASH_SETTLE_MS = 600
/** Gap before confirming a TUI dialog — it has just painted. */
const CONFIRM_KEY_MS = 250
// The codex picker needs a beat to open before digits mean "pick row N".
const CODEX_PICKER_OPEN_MS = 900
const CODEX_PICKER_STEP_MS = 450

/**
 * Keystrokes that switch a live claude session's model and/or effort. Each
 * command is its own Ctrl-U, then the command TYPED, then a delayed CR.
 *
 * Typed, not pasted. These used to ride the composer's bracketed-paste recipe,
 * which silently stopped switching the effort: PTY-probed against claude-code
 * 2.1.221, a pasted `/effort <level>` drops the argument and opens the effort
 * dialog instead, so the CR behind it just confirms the level already set and
 * nothing changes — no error, no confirmation line, nothing in the transcript.
 * (Pasted `/model <alias>` still applies, which is why only half the picker
 * looked broken.) Typed, both commands apply immediately and print their
 * confirmation, mid-turn included — same reason codex's `/model` is typed.
 */
export function buildClaudeModelKeySteps(model?: string, effort?: string): KeyStep[] | null {
  const commands = [
    model ? `/model ${model}` : null,
    effort ? `/effort ${effort}` : null,
  ].filter((c): c is string => c !== null)
  if (commands.length === 0) return null
  const steps: KeyStep[] = []
  for (const cmd of commands) {
    steps.push({ data: '\x15', delayAfterMs: SLASH_CLEAR_MS })
    steps.push({ data: cmd, delayAfterMs: SLASH_CR_DELAY_MS })
    steps.push({ data: '\r', delayAfterMs: SLASH_SETTLE_MS })
    // Switching effort mid-conversation asks for confirmation on 2.1.222+
    // ("Change effort level? … 1. Yes, switch to high" — the cached history has
    // to be re-read), and an unanswered dialog leaves the switch un-applied
    // with nothing on the phone to say so. The digit is CONDITIONAL: the
    // desktop only sends it when that dialog is actually on screen, because a
    // stray "1" into an idle composer would be sent to the agent as a message.
    if (cmd.startsWith('/effort')) {
      steps.push({ data: '1', delayAfterMs: CONFIRM_KEY_MS, ifScreenContains: 'Change effort level?' })
      steps.push({ data: '\r', delayAfterMs: SLASH_SETTLE_MS, ifScreenContains: 'Change effort level?' })
    }
  }
  return steps
}

/**
 * Keystrokes that drive codex's /model picker to a model row + effort row.
 * `/model` is TYPED (not pasted) so the TUI parses it as a slash command,
 * mirroring the verified probe exactly.
 */
export function buildCodexModelKeySteps(modelDigit: string, effortValue: string): KeyStep[] | null {
  if (!/^[1-9]$/.test(modelDigit)) return null
  const effortDigits = effortValue.split(',')
  if (effortDigits.length === 0 || effortDigits.some((d) => !/^[1-9]$/.test(d))) return null
  const steps: KeyStep[] = [
    { data: '\x15', delayAfterMs: KEY_DELAY_MS },
    { data: '/model', delayAfterMs: KEY_DELAY_MS },
    { data: '\r', delayAfterMs: CODEX_PICKER_OPEN_MS },
    { data: modelDigit, delayAfterMs: CODEX_PICKER_STEP_MS },
  ]
  for (const d of effortDigits) steps.push({ data: d, delayAfterMs: CODEX_PICKER_STEP_MS })
  return steps
}
