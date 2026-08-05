// Timeline derivation for the chat pane, ported from t3code's row model.
//
// foldForDisplay() gives us DisplayItems — transcript records with tool results
// folded onto their calls. This module turns those into the rows the timeline
// actually draws: user bubbles, assistant prose, compact tool rows, "+N previous
// tool calls" toggles, and settled turns folded behind a "Worked for 12s"
// header. Pure functions only — the pane owns all state (expansion sets live in
// component state and are passed in; they are lost on remount by design).

import type { DisplayBlock, DisplayItem, QuestionSpec, ToolResultDisplay } from './chat-messages'

export type WorkEntryStatus = 'failed' | 'success' | 'neutral' | 'running'

export type WorkEntry = {
  /** `${itemUid}:${blockIndex}` — stable across re-derives. */
  id: string
  tone: 'thinking' | 'tool'
  /** Tool name (tone 'tool'). */
  name?: string
  /** Compact input summary from the desktop parser (tone 'tool'). */
  input?: string
  /** Thinking text (tone 'thinking'). */
  text?: string
  result?: ToolResultDisplay
  status: WorkEntryStatus
  ts?: number
}

export type QuestionRowBlock = Extract<DisplayBlock, { kind: 'question' }>

export type TimelineRow =
  | { kind: 'user'; id: string; item: DisplayItem; pending: boolean; ts?: number }
  | {
      kind: 'assistant'
      id: string
      uid: string
      /** Contiguous text/image blocks from one transcript record. */
      blocks: DisplayBlock[]
      /** Last prose row of a settled turn — gets the meta row (copy/timestamp). */
      terminal: boolean
      ts?: number
    }
  | { kind: 'work'; id: string; entry: WorkEntry; ts?: number }
  | { kind: 'work-toggle'; id: string; groupId: string; hiddenCount: number; expanded: boolean }
  | { kind: 'turn-fold'; id: string; turnId: string; label: string; expanded: boolean }
  | { kind: 'question'; id: string; uid: string; block: QuestionRowBlock; live: boolean; ts?: number }
  | { kind: 'system'; id: string; text: string; ts?: number }
  | { kind: 'day'; id: string; label: string }
  | { kind: 'working'; id: 'working'; sinceTs: number | null }

const DIVIDER_GAP_MS = 6 * 60 * 60 * 1000

/**
 * Output smells like a failure even when the harness didn't flag isError.
 * Ported from t3code's session-logic heuristics — without these, a bash call
 * that printed "command not found" and exited nonzero renders with a green
 * check.
 */
const FAILURE_PATTERNS: RegExp[] = [
  /exit code [1-9]/i,
  /command not found/i,
  /ENOENT/,
  /EACCES|EPERM/,
  /No such file or directory/i,
  /Traceback \(most recent call last\)/,
  /^error[: ]/im,
  /^fatal: /m,
  /is not recognized as an internal or external command/i,
]

export function outputLooksLikeFailure(output: string): boolean {
  // Only sniff the first chunk: a long successful log that *mentions* an error
  // string deep in its tail shouldn't repaint the row red.
  const head = output.length > 2000 ? output.slice(0, 2000) : output
  return FAILURE_PATTERNS.some((re) => re.test(head))
}

/** `<1s` → 748ms · `<10s` → 3.4s · `<60s` → 42s · else 3m 12s */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 10) return `${(Math.round(s * 10) / 10).toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s - m * 60)
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m - h * 60
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`
}

/** Working-timer flavor: whole seconds, then minutes. 34s · 2m 4s · 1h 12m */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) {
    const rs = s - m * 60
    return rs > 0 ? `${m}m ${rs}s` : `${m}m`
  }
  const h = Math.floor(m / 60)
  const rm = m - h * 60
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`
}

type Turn = {
  id: string
  user: DisplayItem | null
  items: DisplayItem[]
  interrupted: boolean
}

function splitTurns(items: DisplayItem[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null
  for (const item of items) {
    if (item.role === 'user') {
      current = { id: item.uid, user: item, items: [], interrupted: false }
      turns.push(current)
      continue
    }
    if (!current) {
      current = { id: item.uid, user: null, items: [], interrupted: false }
      turns.push(current)
    }
    current.items.push(item)
    // Only a real interrupt marker flags the turn — unknown roles from a newer
    // desktop degrade to 'system' (toMessage) and must not fabricate a
    // "You stopped" label or block the latest turn's fold.
    if (item.role === 'system' && item.blocks.some((b) => b.kind === 'text' && b.text === 'Interrupted'))
      current.interrupted = true
  }
  return turns
}

function entryStatus(
  b: Extract<DisplayBlock, { kind: 'tool' }> | Extract<DisplayBlock, { kind: 'toolResult' }>,
  running: boolean,
): WorkEntryStatus {
  const result = b.kind === 'tool' ? b.result : { output: b.output, isError: b.isError }
  if (!result) return running ? 'running' : 'neutral'
  if (result.isError || outputLooksLikeFailure(result.output)) return 'failed'
  return 'success'
}

/** Per-turn intermediate: the rows of one turn, pre-fold. */
type TurnPiece =
  | { kind: 'assistant'; row: Extract<TimelineRow, { kind: 'assistant' }> }
  | { kind: 'question'; row: Extract<TimelineRow, { kind: 'question' }> }
  | { kind: 'system'; row: Extract<TimelineRow, { kind: 'system' }> }
  | { kind: 'work'; entries: WorkEntry[]; ts?: number }

function buildTurnPieces(turn: Turn, turnRunning: boolean): TurnPiece[] {
  const pieces: TurnPiece[] = []
  const pushWork = (entry: WorkEntry, ts?: number) => {
    const last = pieces[pieces.length - 1]
    if (last && last.kind === 'work') last.entries.push(entry)
    else pieces.push({ kind: 'work', entries: [entry], ts })
  }
  for (const item of turn.items) {
    if (item.role === 'system') {
      // Old plainText() semantics: join every text block, mark images. No
      // 'Interrupted' fallback — a blockless system item renders nothing
      // rather than a fabricated interrupt line.
      const text = item.blocks
        .map((b) => (b.kind === 'text' ? b.text : b.kind === 'image' ? '[image]' : ''))
        .filter(Boolean)
        .join('\n')
      if (text)
        pieces.push({ kind: 'system', row: { kind: 'system', id: item.uid, text, ts: item.ts } })
      continue
    }
    // assistant or standalone-tool item: walk blocks, splitting prose from work
    let proseRun: DisplayBlock[] = []
    let proseStart = 0
    const flushProse = () => {
      if (proseRun.length === 0) return
      pieces.push({
        kind: 'assistant',
        row: {
          kind: 'assistant',
          id: `${item.uid}:s${proseStart}`,
          uid: item.uid,
          blocks: proseRun,
          terminal: false,
          ts: item.ts,
        },
      })
      proseRun = []
    }
    item.blocks.forEach((b, i) => {
      if (b.kind === 'question') {
        flushProse()
        pieces.push({
          kind: 'question',
          row: { kind: 'question', id: `${item.uid}:q${i}`, uid: item.uid, block: b, live: false, ts: item.ts },
        })
        return
      }
      if (b.kind === 'thinking') {
        flushProse()
        pushWork(
          { id: `${item.uid}:${i}`, tone: 'thinking', text: b.text, status: 'neutral', ts: item.ts },
          item.ts,
        )
        return
      }
      if (b.kind === 'tool') {
        flushProse()
        pushWork(
          {
            id: `${item.uid}:${i}`,
            tone: 'tool',
            name: b.name,
            input: b.input,
            result: b.result,
            status: entryStatus(b, turnRunning),
            ts: item.ts,
          },
          item.ts,
        )
        return
      }
      if (b.kind === 'toolResult') {
        // Orphan result whose call fell off the window: keep it visible as its
        // own tool row rather than dropping an error on the floor.
        flushProse()
        pushWork(
          {
            id: `${item.uid}:${i}`,
            tone: 'tool',
            name: 'result',
            // The collapsed row must say something at a glance — this is often
            // an orphaned ERROR whose call fell off the retention window.
            input: firstLine(b.output),
            result: { output: b.output, isError: b.isError },
            status: entryStatus(b, turnRunning),
            ts: item.ts,
          },
          item.ts,
        )
        return
      }
      if (b.kind === 'reset') return
      // text / image
      if (proseRun.length === 0) proseStart = i
      proseRun.push(b)
    })
    flushProse()
  }
  return pieces
}

export type DeriveTimelineOptions = {
  working: boolean
  expandedTurns: ReadonlySet<string>
  expandedGroups: ReadonlySet<string>
  /** Clock injection for tests. */
  now?: number
}

export const MAX_VISIBLE_WORK_ENTRIES = 1

/**
 * DisplayItems → TimelineRows. See module docs. Rules ported from t3:
 *  - a turn = a user message and everything until the next user message
 *  - settled turns fold behind "Worked for Xs"; the last prose row stays out
 *  - within an unsettled/expanded turn, each contiguous work run shows only its
 *    last entry; earlier ones sit behind a "+N previous tool calls" toggle
 *  - a live (unanswered, tail-of-conversation) question renders interactive
 *  - day dividers at >6h gaps; a "working" row is appended while the agent runs
 */
export function deriveTimeline(items: DisplayItem[], opts: DeriveTimelineOptions): TimelineRow[] {
  const { working, expandedTurns, expandedGroups } = opts
  const turns = splitTurns(items)
  const rows: TimelineRow[] = []

  // The live question: an unanswered question block in the very last item.
  // Liveness is decided by position (nothing may follow the form), not by the
  // working flag — the mirror can report idle while the TUI form is still up.
  const lastItem = items.length > 0 ? items[items.length - 1] : null
  let liveQuestionId: string | null = null
  if (lastItem && lastItem.role === 'assistant') {
    for (let i = lastItem.blocks.length - 1; i >= 0; i--) {
      const b = lastItem.blocks[i]
      if (b.kind === 'question' && !b.result) {
        liveQuestionId = `${lastItem.uid}:q${i}`
        break
      }
    }
  }

  turns.forEach((turn, turnIndex) => {
    const isLastTurn = turnIndex === turns.length - 1
    // A turn is unsettled while it's the one the agent is running — or when the
    // user just interrupted it (t3 keeps interrupted turns open so the reader
    // keeps their place; it folds once the next turn starts).
    const unsettled = isLastTurn && (working || turn.interrupted)
    const pieces = buildTurnPieces(turn, isLastTurn && working)

    if (turn.user) {
      rows.push({
        kind: 'user',
        id: turn.user.uid,
        item: turn.user,
        pending: turn.user.uid.startsWith('local:'),
        ts: turn.user.ts,
      })
    }

    // Mark the terminal prose row (last assistant piece of the turn).
    let terminalId: string | null = null
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i]
      if (p.kind === 'assistant') {
        terminalId = p.row.id
        break
      }
    }

    const settled = !unsettled
    const hideable = pieces.filter(
      (p) => !(p.kind === 'assistant' && p.row.id === terminalId) && p.kind !== 'question',
    )
    const hideableCount = hideable.reduce((n, p) => n + (p.kind === 'work' ? p.entries.length : 1), 0)
    const hasLiveQuestion = pieces.some((p) => p.kind === 'question' && p.row.id === liveQuestionId)
    const shouldFold = settled && hideableCount > 0 && !hasLiveQuestion

    if (shouldFold) {
      const expanded = expandedTurns.has(turn.id)
      rows.push({
        kind: 'turn-fold',
        id: `fold:${turn.id}`,
        turnId: turn.id,
        label: foldLabel(turn, pieces),
        expanded,
      })
      if (!expanded) {
        // Only questions and the terminal prose row stay out of the fold.
        for (const p of pieces) {
          if (p.kind === 'question') rows.push(withLive(p.row, liveQuestionId))
          else if (p.kind === 'assistant' && p.row.id === terminalId)
            rows.push({ ...p.row, terminal: true })
        }
        return
      }
    }

    for (const p of pieces) {
      if (p.kind === 'assistant') {
        rows.push({ ...p.row, terminal: settled && p.row.id === terminalId })
        continue
      }
      if (p.kind === 'question') {
        rows.push(withLive(p.row, liveQuestionId))
        continue
      }
      if (p.kind === 'system') {
        rows.push(p.row)
        continue
      }
      // work run — collapse all but the newest entry behind a toggle
      const groupId = `work-group:${p.entries[0].id}`
      const expanded = expandedGroups.has(groupId) || shouldFold
      // ^ inside an expanded turn-fold the reader asked to see everything;
      //   nesting a second toggle there would just add clicks.
      const hidden = p.entries.length - MAX_VISIBLE_WORK_ENTRIES
      if (hidden > 0 && !expanded) {
        const entry = p.entries[p.entries.length - 1]
        rows.push({ kind: 'work', id: entry.id, entry, ts: entry.ts })
        rows.push({ kind: 'work-toggle', id: `toggle:${groupId}`, groupId, hiddenCount: hidden, expanded: false })
      } else {
        for (const entry of p.entries) rows.push({ kind: 'work', id: entry.id, entry, ts: entry.ts })
        // "Show fewer" only where the reader opened the group themselves — an
        // expanded turn-fold already has its own collapse affordance.
        if (hidden > 0 && !shouldFold)
          rows.push({ kind: 'work-toggle', id: `toggle:${groupId}`, groupId, hiddenCount: hidden, expanded: true })
      }
    }
  })

  const withDividers = insertDayDividers(rows)

  if (working) {
    // The NEWEST user item decides, ts or not — walking past a ts-less echo to
    // an older message would start the "Working for…" timer hours in the past.
    let sinceTs: number | null = null
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item.role === 'user') {
        sinceTs = item.ts ?? null
        break
      }
    }
    withDividers.push({ kind: 'working', id: 'working', sinceTs })
  }
  return withDividers
}

function withLive(
  row: Extract<TimelineRow, { kind: 'question' }>,
  liveQuestionId: string | null,
): Extract<TimelineRow, { kind: 'question' }> {
  return row.id === liveQuestionId ? { ...row, live: true } : row
}

function foldLabel(turn: Turn, pieces: TurnPiece[]): string {
  const start = turn.user?.ts
  let end: number | undefined
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i]
    const ts = p.kind === 'work' ? p.entries[p.entries.length - 1].ts : p.row.ts
    if (ts != null) {
      end = ts
      break
    }
  }
  const interrupted = turn.interrupted
  if (start != null && end != null && end > start) {
    const dur = formatDuration(end - start)
    return interrupted ? `You stopped after ${dur}` : `Worked for ${dur}`
  }
  return interrupted ? 'You stopped this response' : 'Worked'
}

function insertDayDividers(rows: TimelineRow[]): TimelineRow[] {
  const out: TimelineRow[] = []
  let lastTs: number | null = null
  for (const row of rows) {
    const ts = 'ts' in row ? row.ts : undefined
    if (ts != null) {
      if (lastTs != null && ts - lastTs > DIVIDER_GAP_MS) {
        const day: TimelineRow = { kind: 'day', id: `day:${ts}`, label: formatDayLabel(ts) }
        // A ts-less fold header may already sit between the gap and this row —
        // the date belongs above the whole turn, never inside it.
        if (out[out.length - 1]?.kind === 'turn-fold') out.splice(out.length - 1, 0, day)
        else out.push(day)
      }
      lastTs = ts
    }
    out.push(row)
  }
  return out
}

function formatDayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** First non-empty line, for one-line previews (thinking rows, tool output). */
export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.length > 0) return t
  }
  return ''
}

export function isDrivableQuestionRow(questions: QuestionSpec[]): boolean {
  return questions.length > 0 && questions.every((q) => q.options.length > 0)
}
