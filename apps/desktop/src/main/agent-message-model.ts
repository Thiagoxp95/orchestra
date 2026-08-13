// Turns raw agent-transcript JSONL lines into the structured ChatMessage shape
// the phone's chat mirror renders. Two dialects share one wire model:
//
//   Claude: ~/.claude/projects/<slug>/<sessionId>.jsonl — one record per line,
//           `type` user/assistant carries the conversation; everything else
//           (mode, attachment, file-history-*, ai-title, system, summary…) is
//           harness bookkeeping the chat view must not show.
//   Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — `response_item`
//           lines are the canonical conversation; `event_msg` lines duplicate
//           the same user/agent text for codex's own event bus (verified
//           against real rollouts: identical strings on both), so we parse
//           response_item only and drop event_msg to avoid double messages.
//
// Pure module by design: no fs, no Convex. The tailer feeds lines in and pushes
// ChatMessages out, which keeps every format decision testable without disk or
// network. Neither parser ever throws — transcripts are written concurrently by
// another process, so torn lines, unknown record types, and format drift are
// normal operating conditions, not exceptions. Garbage maps to [].
//
// Sizes are capped HERE, at the producer, so the Convex rows and the web
// renderer can trust what they receive: a single pathological tool result must
// not balloon a mutation payload or a phone paint.

import { CLAUDE_SYNTHETIC_USER_PREFIXES, normalizeCodexUserMessage } from './agent-session-history'
import { stripAnsi } from './terminal-output-text'

export type QuestionOption = { label: string; description?: string }
export type QuestionSpec = {
  question: string
  header?: string
  multiSelect?: boolean
  options: QuestionOption[]
  /**
   * Any option carries a `preview`, which changes the TUI form's SHAPE and so
   * changes the keys that answer it: a preview form renders the options
   * side-by-side with the preview pane and drops the numbered
   * "Type something."/"Chat about this" rows (they become arrow-reachable
   * only). The previews themselves are not mirrored — the phone shows labels
   * and descriptions — but which layout the desktop is showing has to be known
   * to drive it. See buildQuestionKeySequence on the web.
   */
  hasPreview?: boolean
}

export type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  // A tool invocation. `input` is a compact human summary (the command line,
  // the file path), not raw JSON. `id` pairs it with a later result.
  | { kind: 'tool'; id?: string; name: string; input: string }
  // An AskUserQuestion form, structured so the phone can render (and answer)
  // the real TUI form instead of showing a truncated JSON tool row. `id` pairs
  // it with the tool result exactly like a tool block.
  | { kind: 'question'; id?: string; questions: QuestionSpec[] }
  // A tool result. `forId` pairs it back to the call; unmatched results render
  // standalone. `answers` is AskUserQuestion's structured question→choice map,
  // lifted from the transcript record's toolUseResult.
  | { kind: 'toolResult'; forId?: string; output: string; isError?: boolean; answers?: Record<string, string> }
  | { kind: 'image'; alt?: string }
  // A conversation cut. Synthesized by the message mirror (never parsed from a
  // transcript) when a session's transcript swaps to a different file: every
  // row before it belongs to a conversation the terminal no longer shows, and
  // the web drops what it holds at the marker (see cutAtReset over there).
  | { kind: 'reset' }
  // Marks a user message claude-code is still HOLDING: typed while the agent
  // was mid-turn, so it sits in the queue until the next tool boundary (or the
  // end of the turn) instead of becoming a conversation record. Without this
  // row the phone showed nothing at all for a queued send — the transcript
  // records it as `queue-operation`/`attachment`, neither of which used to
  // parse — so a message sent from the couch looked dropped. The record that
  // finally delivers it is mirrored as its own row, and this one comes down.
  | { kind: 'queued' }
  // Takes queued rows down by uid. Synthesized by the message mirror when the
  // transcript says a message left claude's queue — delivered into the running
  // turn, drained into the next one, or cancelled at the TUI. A marker row
  // rather than an edit to the queued row for the reason spelled out in the
  // queue section below: the web's cursor never looks back.
  | { kind: 'unqueued'; uids: string[] }

export type ChatMessage = {
  /** Stable identity: Claude record uuid; Codex `<fileBase>:<lineNo>`. */
  uid: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  blocks: ChatBlock[]
  /** ms epoch from the transcript timestamp, when present. */
  ts?: number
}

type ToolBlock = Extract<ChatBlock, { kind: 'tool' }>
type ToolResultBlock = Extract<ChatBlock, { kind: 'toolResult' }>

// Caps per the mirror contract. Text and results are middle-truncated (head +
// tail) because both ends matter: the head carries the intent, the tail carries
// the conclusion/exit status. Tool input is end-truncated — a command line's
// head identifies it.
export const TEXT_CAP = 6000
const TEXT_HEAD = 4000
const TEXT_TAIL = 1500
export const THINKING_CAP = 2000
const THINKING_HEAD = 1400
const THINKING_TAIL = 400
export const TOOL_INPUT_CAP = 600
// AskUserQuestion caps. The tool's own schema allows at most 4 questions × 4
// options; these sit above that so a well-formed call is never clipped, while
// a malformed/hostile one stays bounded.
export const MAX_QUESTIONS = 5
export const MAX_QUESTION_OPTIONS = 6
const QUESTION_CAP = 400
const QUESTION_HEADER_CAP = 40
const OPTION_LABEL_CAP = 120
const OPTION_DESC_CAP = 350
export const TOOL_RESULT_CAP = 2500
const TOOL_RESULT_HEAD = 1700
const TOOL_RESULT_TAIL = 600
export const MAX_BLOCKS_PER_MESSAGE = 32

export function truncateMiddle(text: string, cap: number, head: number, tail: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - tail)}`
}

function capText(text: string): string {
  return truncateMiddle(text, TEXT_CAP, TEXT_HEAD, TEXT_TAIL)
}

function capThinking(text: string): string {
  return truncateMiddle(text, THINKING_CAP, THINKING_HEAD, THINKING_TAIL)
}

function capEnd(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap - 1)}…`
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

/** Wrap blocks into the 0-or-1 message array both parsers return. */
function toMessages(
  uid: string,
  role: ChatMessage['role'],
  blocks: ChatBlock[],
  ts: number | undefined,
): ChatMessage[] {
  if (blocks.length === 0) return []
  const message: ChatMessage = { uid, role, blocks: blocks.slice(0, MAX_BLOCKS_PER_MESSAGE) }
  if (ts !== undefined) message.ts = ts
  return [message]
}

// ---------------------------------------------------------------------------
// Tool-input summaries
// ---------------------------------------------------------------------------

/**
 * The generic fallback key order when a tool has no named rule. Ordered by how
 * well each key identifies the call at a glance; covers codex's tools
 * (exec_command→cmd, shell→command[], write_stdin→chars) and MCP tools without
 * needing a per-tool rule for each.
 */
const GENERIC_INPUT_KEYS = [
  'command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url',
  'description', 'message', 'text', 'chars',
]

/**
 * Compact one-line summary of a tool invocation for the chat view's tool rows.
 * `input` is whatever the transcript recorded — Claude's parsed input object,
 * codex's JSON-decoded arguments, or a raw string (codex custom_tool_call
 * records e.g. the literal JS source for its `exec` tool as a plain string).
 */
export function summarizeToolInput(name: string, input: unknown): string {
  if (typeof input === 'string') return capEnd(input, TOOL_INPUT_CAP)
  const obj = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null
  const pick = (key: string): string | null => {
    const value = obj?.[key]
    if (typeof value === 'string' && value.length > 0) return value
    // codex's shell tool records its command as an argv array.
    if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')) {
      return value.join(' ')
    }
    return null
  }
  let summary: string | null = null
  switch (name) {
    case 'Bash':
      summary = pick('command')
      break
    case 'Read':
    case 'Write':
    case 'Edit':
      summary = pick('file_path')
      break
    case 'Grep':
    case 'Glob':
      summary = pick('pattern')
      break
    case 'Task':
      summary = pick('description')
      break
    case 'WebFetch':
      summary = pick('url')
      break
    case 'WebSearch':
      summary = pick('query')
      break
    case 'TodoWrite':
      // The todos array is bulky and the update itself is the news.
      return 'update todos'
  }
  if (!summary) {
    for (const key of GENERIC_INPUT_KEYS) {
      summary = pick(key)
      if (summary) break
    }
  }
  if (!summary) {
    try {
      summary = JSON.stringify(input) ?? ''
    } catch {
      summary = ''
    }
  }
  return capEnd(summary, TOOL_INPUT_CAP)
}

// ---------------------------------------------------------------------------
// AskUserQuestion forms
// ---------------------------------------------------------------------------

/**
 * Validate an AskUserQuestion tool_use input into the structured questions the
 * phone renders as a form. Strict about the parts the phone's answer driver
 * depends on (a non-empty options list per question — option INDEX is what the
 * driver types into the TUI), lenient about everything else. Returns null on
 * any shape surprise so the caller can fall back to a generic tool row.
 */
export function parseQuestionInput(input: unknown): QuestionSpec[] | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw) || raw.length === 0) return null
  const questions: QuestionSpec[] = []
  for (const item of raw.slice(0, MAX_QUESTIONS)) {
    if (!item || typeof item !== 'object') return null
    const q = item as Record<string, unknown>
    if (typeof q.question !== 'string' || !q.question.trim()) return null
    if (!Array.isArray(q.options) || q.options.length === 0) return null
    const options: QuestionOption[] = []
    let hasPreview = false
    for (const o of q.options.slice(0, MAX_QUESTION_OPTIONS)) {
      if (!o || typeof o !== 'object') return null
      const opt = o as Record<string, unknown>
      if (typeof opt.label !== 'string' || !opt.label.trim()) return null
      const parsed: QuestionOption = { label: capEnd(opt.label, OPTION_LABEL_CAP) }
      if (typeof opt.description === 'string' && opt.description.trim()) {
        parsed.description = capEnd(opt.description, OPTION_DESC_CAP)
      }
      if (typeof opt.preview === 'string' && opt.preview.trim()) hasPreview = true
      options.push(parsed)
    }
    const spec: QuestionSpec = { question: capEnd(q.question, QUESTION_CAP), options }
    if (hasPreview) spec.hasPreview = true
    if (typeof q.header === 'string' && q.header.trim()) {
      spec.header = capEnd(q.header, QUESTION_HEADER_CAP)
    }
    if (q.multiSelect === true) spec.multiSelect = true
    questions.push(spec)
  }
  return questions
}

/**
 * Message identity for an AskUserQuestion form, derived from the tool_use id
 * rather than the transcript record's uuid.
 *
 * The form is mirrored TWICE from two sources: the PreToolUse hook fires the
 * moment the form opens (see remote-bridge-messages noteClaudeQuestion), and
 * the transcript record carrying the same tool_use arrives later. Only the
 * hook copy is early enough for the phone to answer, but it has no record
 * uuid, so both are keyed on the tool_use id instead — appendMessages then
 * upserts the transcript copy ONTO the hook row (keeping its seq) instead of
 * rendering the same form twice.
 */
export function questionUid(toolUseId: string): string {
  return `askq:${toolUseId}`
}

/** The `askq:` uid for a parsed block list, or null if it holds no identified
 *  question — the transcript half of the pairing above. */
export function questionMessageUid(blocks: ChatBlock[]): string | null {
  for (const b of blocks) {
    if (b.kind === 'question' && typeof b.id === 'string' && b.id) return questionUid(b.id)
  }
  return null
}

/**
 * Build the mirrored message for a live AskUserQuestion form out of a
 * PreToolUse hook payload's `tool_input`. Same validation as the transcript
 * path (a shape surprise yields null and nothing is pushed — the transcript
 * copy still arrives later either way).
 */
export function buildQuestionMessage(
  toolUseId: string,
  toolInput: unknown,
  ts: number,
): ChatMessage | null {
  const questions = parseQuestionInput(toolInput)
  if (!questions) return null
  return {
    uid: questionUid(toolUseId),
    role: 'assistant',
    blocks: [{ kind: 'question', id: toolUseId, questions }],
    ts,
  }
}

/**
 * The question→answer map Claude Code records on the answered user record
 * (entry-level toolUseResult.answers). Kept per-entry small: both sides are
 * text the parser already capped upstream in the question block, but the map
 * arrives independently so it gets its own bounds.
 */
export function parseQuestionAnswers(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const answers: Record<string, string> = {}
  let count = 0
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'string') continue
    if (++count > MAX_QUESTIONS) break
    // Values can be free-typed "Other" answers, not just option labels.
    answers[capEnd(k, QUESTION_CAP)] = capEnd(v, 1000)
  }
  return count > 0 ? answers : null
}

// ---------------------------------------------------------------------------
// Tool-result flattening
// ---------------------------------------------------------------------------

/**
 * Both agents record result content in several shapes: a plain string, a list
 * of text-ish blocks (Claude `text`, codex `input_text`/`output_text`), lists
 * carrying images, or — defensively — arbitrary JSON. Images are surfaced as a
 * count so callers can emit `image` blocks; unknown block kinds (Claude's
 * `tool_reference`, whatever ships next) are dropped rather than stringified.
 */
function collectResultContent(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 }
  if (Array.isArray(content)) {
    const parts: string[] = []
    let images = 0
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const block = item as { type?: unknown; text?: unknown }
      if (
        (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text')
        && typeof block.text === 'string'
      ) {
        parts.push(block.text)
      } else if (block.type === 'image' || block.type === 'input_image') {
        images++
      }
    }
    return { text: parts.join('\n'), images }
  }
  if (content == null) return { text: '', images: 0 }
  try {
    return { text: JSON.stringify(content) ?? '', images: 0 }
  } catch {
    return { text: '', images: 0 }
  }
}

export function flattenToolResult(content: unknown): string {
  return truncateMiddle(
    collectResultContent(content).text,
    TOOL_RESULT_CAP,
    TOOL_RESULT_HEAD,
    TOOL_RESULT_TAIL,
  )
}

// ---------------------------------------------------------------------------
// Claude transcript records
// ---------------------------------------------------------------------------

/**
 * Slash commands land in the transcript as an XML envelope
 * (`<command-name>/model</command-name><command-message>…</command-args>`).
 * The chat view shows what the person effectively typed: `/model` or
 * `/goal ship the thing`.
 */
function extractCommandText(text: string): string | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim()
  if (!name) return null
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

/**
 * `/model` and `/effort` are reported twice: the envelope the person typed, and
 * a `<local-command-stdout>` echo naming what it resolved to. The chat keeps
 * only the second, as a compact system marker ("Model → Opus 5").
 *
 * Why not just show the `/model opus` bubble: a switch typed at the DESKTOP is
 * otherwise invisible in the phone's chat, while the model pill moves on its
 * own one turn later (the transcript stamps the new model only when the agent
 * next replies). A pill that changes with nothing in the conversation to
 * explain it reads as the pill being wrong — and the agent, whose system prompt
 * was stamped at session start, will cheerfully claim the OLD model and
 * contradict it. One row in the timeline is the shared account of what happened.
 */
const SWITCH_STDOUT_RE = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/
const SWITCH_KINDS = [
  { prefix: 'Set model to ', label: 'Model' },
  { prefix: 'Set effort level to ', label: 'Effort' },
] as const

/** Drop the CLI's trailing "and saved as your default…" / "(saved as…): desc". */
function switchValue(rest: string): string {
  return rest.split(/\s+and saved as|\s*\(saved as|:/)[0]!.trim()
}

function claudeSwitchNotice(texts: string[]): string | null {
  for (const raw of texts) {
    const inner = SWITCH_STDOUT_RE.exec(raw.trim())?.[1]
    if (inner == null) continue
    // The CLI bolds the model name with SGR codes.
    const clean = stripAnsi(inner).trim()
    for (const { prefix, label } of SWITCH_KINDS) {
      if (!clean.startsWith(prefix)) continue
      const value = switchValue(clean.slice(prefix.length))
      if (value) return `${label} → ${value}`
    }
  }
  return null
}

/** The envelope whose result claudeSwitchNotice already renders. */
function isSwitchCommand(command: string): boolean {
  const name = command.split(/\s/, 1)[0]
  return name === '/model' || name === '/effort'
}

/**
 * Harness plumbing that shows up as `user` records but was never typed by a
 * person. The prefix list is agent-session-history's canonical one — one
 * source, so a new harness banner starts being filtered in both the history
 * summaries and this mirror by being added there once. Deliberately narrower
 * than its isSyntheticUserText: the command envelope (`<command-name>`…) is
 * NOT synthetic here, because the chat view re-renders it as the
 * `/command args` the person effectively typed — see extractCommandText.
 * `<system-reminder>` is filtered per text block (hooks can inject a reminder
 * block alongside the real prompt), the rest as whole-message prefixes.
 */
function isClaudeSyntheticText(text: string): boolean {
  const trimmed = text.trimStart()
  return CLAUDE_SYNTHETIC_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

/**
 * When a user record's content is entirely tool_result blocks it is the tool
 * side of an agentic loop, not something the person said — emit it as role
 * 'tool' so the web can fold results into the preceding assistant's tool rows.
 * Mixed content (any non-tool_result block present) falls through to the text
 * path instead.
 */
function claudeToolResultBlocks(content: unknown, entryToolUseResult?: unknown): ChatBlock[] | null {
  if (!Array.isArray(content) || content.length === 0) return null
  const results: ChatBlock[] = []
  let resultCount = 0
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const block = item as { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown }
    if (block.type !== 'tool_result') return null
    resultCount++
    const { text, images } = collectResultContent(block.content)
    const result: ToolResultBlock = {
      kind: 'toolResult',
      output: truncateMiddle(text, TOOL_RESULT_CAP, TOOL_RESULT_HEAD, TOOL_RESULT_TAIL),
    }
    if (typeof block.tool_use_id === 'string') result.forId = block.tool_use_id
    if (block.is_error === true) result.isError = true
    results.push(result)
    for (let i = 0; i < images; i++) results.push({ kind: 'image' })
  }
  // AskUserQuestion's structured answers live on the ENTRY (toolUseResult),
  // not inside the content block — attach them only when the record carries
  // exactly one result, so there's no ambiguity about which call they answer.
  if (resultCount === 1 && entryToolUseResult && typeof entryToolUseResult === 'object') {
    const answers = parseQuestionAnswers((entryToolUseResult as { answers?: unknown }).answers)
    if (answers) {
      const only = results.find((b): b is ToolResultBlock => b.kind === 'toolResult')
      if (only) only.answers = answers
    }
  }
  return results.length > 0 ? results : null
}

function claudeAssistantBlocks(content: unknown): ChatBlock[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ kind: 'text', text: capText(content) }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: ChatBlock[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const block = item as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text.trim()) blocks.push({ kind: 'text', text: capText(block.text) })
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      // Claude writes empty thinking blocks (signature only) — nothing to show.
      if (block.thinking.trim()) blocks.push({ kind: 'thinking', text: capThinking(block.thinking) })
    } else if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
      // AskUserQuestion carries a whole form in its input — mirror it
      // structured so the phone can render and answer it. A shape surprise
      // falls through to the generic tool row.
      const questions = block.name === 'AskUserQuestion' ? parseQuestionInput(block.input) : null
      if (questions) {
        const question: Extract<ChatBlock, { kind: 'question' }> = { kind: 'question', questions }
        if (typeof block.id === 'string') question.id = block.id
        blocks.push(question)
      } else {
        const tool: ToolBlock = {
          kind: 'tool',
          name: block.name,
          input: summarizeToolInput(block.name, block.input),
        }
        if (typeof block.id === 'string') tool.id = block.id
        blocks.push(tool)
      }
    } else if (block.type === 'image') {
      blocks.push({ kind: 'image' })
    }
    // Unknown kinds (redacted_thinking, future additions): skip.
  }
  return blocks
}

// ---------------------------------------------------------------------------
// The message queue
// ---------------------------------------------------------------------------
//
// Typing while claude is mid-turn queues the message rather than submitting it,
// and the transcript says so in records the conversation parser ignores:
//
//   {"type":"queue-operation","operation":"enqueue","timestamp":T,"content":…}
//   {"type":"queue-operation","operation":"remove",  "timestamp":…,"content":…}
//   {"type":"queue-operation","operation":"dequeue", "timestamp":…,"content":null}
//   {"type":"attachment","attachment":{"type":"queued_command","prompt":…,
//                                      "timestamp":T}}
//
// Two exits from the queue. Mid-turn STEERING: `remove` names the message, and
// the `attachment` immediately after it is the copy that actually reached the
// model — there is never an ordinary `user` record for it. End-of-turn DRAIN:
// `dequeue` names nothing (its content is null) and the queue's messages are
// re-recorded as ordinary `user` records with their own uuids.
//
// Either way the message ends up mirrored twice — once as the queued row, once
// as the record that delivered it — so leaving the queue has to take the queued
// row down. It can't do that by patching it: appendMessages keeps a patched
// row's seq, and the web's live tail only ever asks for seqs ABOVE its cursor,
// so an edit to a row it has already passed never reaches a mounted pane. The
// mirror emits an `unqueued` marker instead — a new row, at a new seq, naming
// the rows to drop — exactly like the `reset` marker that handles the same
// problem for a conversation swap.

/** Row identity of a queued message: its enqueue timestamp, which is the only
 *  thing every later record about it carries. */
function queuedUid(timestamp: unknown): string | null {
  return typeof timestamp === 'string' && timestamp ? `queued:${timestamp}` : null
}

/** The text of a queued message, or null when there is nothing to show for it
 *  (empty, or harness plumbing — task notifications queue like anything else). */
function queuedText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || isClaudeSyntheticText(trimmed)) return null
  return trimmed
}

/**
 * The body of a `queued_command` attachment. Claude records a typed message as
 * a plain string, but a message carrying an image as a CONTENT-BLOCK ARRAY
 * (`[{type:'text'},{type:'image'}]`) — so a string-only reader silently drops
 * every phone-sent photo that got steered into a running turn, and since the
 * enqueue row is taken back down by the `remove` marker the message ends up
 * with no trace in the chat at all.
 */
function queuedPrompt(value: unknown): { text: string | null; images: number } {
  if (!Array.isArray(value)) return { text: queuedText(value), images: 0 }
  const parts: string[] = []
  let images = 0
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const block = item as { type?: unknown; text?: unknown }
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') images++
  }
  return { text: queuedText(parts.join('\n')), images }
}

/**
 * What one `queue-operation` record does to the queue. The mirror needs this
 * beyond the message parse below, because retracting a row means knowing which
 * uid it had: `remove` identifies its message by content and `dequeue` by
 * nothing at all, so only a reader that remembers the enqueues can map either
 * one back to a row. Returns null for every other line.
 */
export type ClaudeQueueOp =
  | { op: 'enqueue'; uid: string; text: string }
  | { op: 'remove'; text: string }
  | { op: 'drain' }

export function parseClaudeQueueOp(line: string): ClaudeQueueOp | null {
  const entry = parseJsonObject(line)
  if (!entry || entry.type !== 'queue-operation') return null
  if (entry.operation === 'dequeue') return { op: 'drain' }
  const text = queuedText(entry.content)
  if (!text) return null
  if (entry.operation === 'remove') return { op: 'remove', text }
  if (entry.operation !== 'enqueue') return null
  const uid = queuedUid(entry.timestamp)
  return uid ? { op: 'enqueue', uid, text } : null
}

/** `queue-operation`/enqueue → the pending user bubble. */
function parseClaudeEnqueue(entry: Record<string, unknown>): ChatMessage[] {
  if (entry.operation !== 'enqueue') return []
  const uid = queuedUid(entry.timestamp)
  const text = queuedText(entry.content)
  if (!uid || !text) return []
  return toMessages(
    uid,
    'user',
    [{ kind: 'queued' }, { kind: 'text', text: capText(text) }],
    parseTimestamp(entry.timestamp),
  )
}

/**
 * `attachment`/queued_command → the ordinary user bubble for a message claude
 * steered into a running turn. This is the ONLY record of it as conversation —
 * a steered message never gets a `user` record — so without this the message
 * the person sent from the phone reached the model and left no trace anywhere
 * the chat view could see it.
 */
function parseClaudeQueuedCommand(entry: Record<string, unknown>): ChatMessage[] {
  const attachment = entry.attachment
  if (!attachment || typeof attachment !== 'object') return []
  const a = attachment as { type?: unknown; prompt?: unknown; timestamp?: unknown }
  if (a.type !== 'queued_command') return []
  const uid = typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : queuedUid(a.timestamp)
  const { text, images } = queuedPrompt(a.prompt)
  if (!uid || (!text && images === 0)) return []
  // Text first, then one block per image — the same shape the ordinary user
  // path emits, so the web bubble renders both identically.
  const blocks: ChatBlock[] = []
  if (text) blocks.push({ kind: 'text', text: capText(text) })
  for (let i = 0; i < images; i++) blocks.push({ kind: 'image' })
  return toMessages(
    uid,
    'user',
    blocks,
    parseTimestamp(a.timestamp) ?? parseTimestamp(entry.timestamp),
  )
}

/**
 * Parse one Claude transcript line into 0 or 1 ChatMessages.
 *
 * Only `user`/`assistant` records are conversation; sidechains are a different
 * conversation (sub-agent threads), compact summaries re-narrate history the
 * mirror already showed, and meta records are harness annotations — except the
 * meta records whose content is entirely tool_result blocks, which ARE the
 * tool loop and must flow through as role 'tool'.
 */
export function parseClaudeLine(line: string): ChatMessage[] {
  const entry = parseJsonObject(line)
  if (!entry) return []
  // Queue records are conversation too — the person typed them (see above).
  if (entry.type === 'queue-operation') return parseClaudeEnqueue(entry)
  if (entry.type === 'attachment') return parseClaudeQueuedCommand(entry)
  if (entry.type !== 'user' && entry.type !== 'assistant') return []
  if (entry.isSidechain === true) return []
  if (entry.isCompactSummary === true) return []
  const uid = typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : null
  if (!uid) return []
  const message = entry.message
  if (!message || typeof message !== 'object') return []
  const content = (message as { content?: unknown }).content
  const ts = parseTimestamp(entry.timestamp)

  if (entry.type === 'assistant') {
    const blocks = claudeAssistantBlocks(content)
    // A record holding a question form is keyed on the tool_use id so it lands
    // on the row the PreToolUse hook already pushed (see questionUid).
    return toMessages(questionMessageUid(blocks) ?? uid, 'assistant', blocks, ts)
  }

  const toolBlocks = claudeToolResultBlocks(content, entry.toolUseResult)
  if (toolBlocks) return toMessages(uid, 'tool', toolBlocks, ts)
  if (entry.isMeta === true) return []

  // Text path: string content, or a list of text/image blocks.
  const texts: string[] = []
  let images = 0
  if (typeof content === 'string') {
    texts.push(content)
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const block = item as { type?: unknown; text?: unknown }
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      else if (block.type === 'image') images++
    }
  } else {
    return []
  }

  // Checked BEFORE the synthetic filter: `<local-command-stdout>` is on the
  // synthetic prefix list, so the switch echo would otherwise be dropped whole.
  const switchNotice = claudeSwitchNotice(texts)
  if (switchNotice) return toMessages(uid, 'system', [{ kind: 'text', text: switchNotice }], ts)

  const joined = texts
    .filter((text) => !isClaudeSyntheticText(text))
    .join('\n')
    .trim()
  // Was the whole message synthetic (stdout echo, reminder, caveat)? Then skip
  // the record even if it had a raw string body.
  if (!joined && texts.some((text) => isClaudeSyntheticText(text))) return []

  // The interrupt boilerplate ("[Request interrupted by user]", "…for tool
  // use") is the harness speaking, not the person — render it as a compact
  // system marker.
  if (joined.startsWith('[Request interrupted')) {
    return toMessages(uid, 'system', [{ kind: 'text', text: 'Interrupted' }], ts)
  }
  if (joined.startsWith('<command-name>')) {
    const command = extractCommandText(joined)
    if (!command || isSwitchCommand(command)) return []
    return toMessages(uid, 'user', [{ kind: 'text', text: capEnd(command, TOOL_INPUT_CAP) }], ts)
  }

  const blocks: ChatBlock[] = []
  if (joined) blocks.push({ kind: 'text', text: capText(joined) })
  for (let i = 0; i < images; i++) blocks.push({ kind: 'image' })
  return toMessages(uid, 'user', blocks, ts)
}

// ---------------------------------------------------------------------------
// Codex rollout records
// ---------------------------------------------------------------------------

/**
 * Synthetic user-message envelopes codex injects as `role: user` response
 * items. `<environment_context>`/`<user_instructions>` are the contract-named
 * pair; the rest were found in real rollouts on this machine
 * (`<recommended_plugins>` plugin ads, `<subagent_notification>` sub-worker
 * status dumps, `<runtime>` delegation wrappers). None were typed by a person.
 */
const CODEX_SYNTHETIC_USER_TAGS = [
  '<environment_context>',
  '<user_instructions>',
  '<permissions instructions>',
  '<recommended_plugins>',
  '<subagent_notification>',
  '<runtime>',
]

function collectCodexMessageContent(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 }
  if (!Array.isArray(content)) return { text: '', images: 0 }
  const parts: string[] = []
  let images = 0
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const block = item as { type?: unknown; text?: unknown }
    if (
      (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text')
      && typeof block.text === 'string'
    ) {
      parts.push(block.text)
    } else if (block.type === 'input_image' || block.type === 'image') {
      images++
    }
  }
  return { text: parts.join('\n'), images }
}

/** codex records function arguments as a JSON string; decode when possible so
 * summarizeToolInput can pick the meaningful key, keep the raw string when
 * not (it still identifies the call better than nothing). */
function decodeCodexArguments(args: unknown): unknown {
  if (typeof args !== 'string') return args
  try {
    return JSON.parse(args)
  } catch {
    return args
  }
}

/**
 * Parse one codex rollout line into 0 or 1 ChatMessages.
 *
 * Only `response_item` records are parsed — they are the canonical
 * conversation. `event_msg` duplicates user/agent text (confirmed identical in
 * real rollouts), and session_meta/turn_context/world_state are bookkeeping.
 * Codex line records have no per-record uuid, so identity is positional:
 * `<fileBase>:<lineNo>` — stable because rollouts are append-only.
 */
export function parseCodexLine(line: string, lineNo: number, fileBase: string): ChatMessage[] {
  const entry = parseJsonObject(line)
  if (!entry) return []
  if (entry.type !== 'response_item') return []
  const payload = entry.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const p = payload as Record<string, unknown>
  const uid = `${fileBase}:${lineNo}`
  const ts = parseTimestamp(entry.timestamp)

  switch (p.type) {
    case 'message': {
      const { text, images } = collectCodexMessageContent(p.content)
      if (p.role === 'assistant') {
        return text.trim() ? toMessages(uid, 'assistant', [{ kind: 'text', text: capText(text) }], ts) : []
      }
      // `developer` (permissions, apps instructions) and any future roles are
      // plumbing, not conversation.
      if (p.role !== 'user') return []
      const trimmed = text.trimStart()
      // Codex records an interrupt as a synthetic `<turn_aborted>` user
      // message — same meaning as Claude's "[Request interrupted]", same
      // rendering.
      if (trimmed.startsWith('<turn_aborted>')) {
        return toMessages(uid, 'system', [{ kind: 'text', text: 'Interrupted' }], ts)
      }
      if (CODEX_SYNTHETIC_USER_TAGS.some((tag) => trimmed.startsWith(tag))) return []
      // Strip Codex Desktop's attachment preamble down to the typed request;
      // an attachment-only turn keeps its images (the photo IS the message)
      // but drops the file-listing boilerplate.
      const normalized = normalizeCodexUserMessage(text)
      const blocks: ChatBlock[] = []
      if (normalized) blocks.push({ kind: 'text', text: capText(normalized) })
      for (let i = 0; i < images; i++) blocks.push({ kind: 'image' })
      return toMessages(uid, 'user', blocks, ts)
    }
    case 'reasoning': {
      // Only the summary texts are readable — `encrypted_content` is opaque
      // and `content` has been observed empty in every real rollout.
      const summary = Array.isArray(p.summary) ? p.summary : []
      const blocks: ChatBlock[] = []
      for (const item of summary) {
        if (!item || typeof item !== 'object') continue
        const block = item as { type?: unknown; text?: unknown }
        if (block.type === 'summary_text' && typeof block.text === 'string' && block.text.trim()) {
          blocks.push({ kind: 'thinking', text: capThinking(block.text) })
        }
      }
      return toMessages(uid, 'assistant', blocks, ts)
    }
    // `function_call` carries JSON-string arguments; `custom_tool_call` (what
    // current codex writes for most tools) carries a raw `input` string.
    // Identical on the wire model: an assistant tool row keyed by call_id.
    case 'function_call':
    case 'custom_tool_call': {
      if (typeof p.name !== 'string' || !p.name) return []
      const rawInput = p.type === 'custom_tool_call' ? p.input : decodeCodexArguments(p.arguments)
      const tool: ToolBlock = { kind: 'tool', name: p.name, input: summarizeToolInput(p.name, rawInput) }
      if (typeof p.call_id === 'string') tool.id = p.call_id
      return toMessages(uid, 'assistant', [tool], ts)
    }
    case 'local_shell_call': {
      const action = p.action && typeof p.action === 'object' ? (p.action as Record<string, unknown>) : null
      const rawCommand = action?.command
      const command = Array.isArray(rawCommand) && rawCommand.every((v) => typeof v === 'string')
        ? (rawCommand as string[]).join(' ')
        : ''
      const tool: ToolBlock = { kind: 'tool', name: 'shell', input: capEnd(command, TOOL_INPUT_CAP) }
      const callId = typeof p.call_id === 'string' ? p.call_id : typeof p.id === 'string' ? p.id : undefined
      if (callId) tool.id = callId
      return toMessages(uid, 'assistant', [tool], ts)
    }
    // Not contract-required, but real rollouts carry these and a silent gap
    // where the agent searched the web reads as a stall on the phone.
    case 'web_search_call': {
      const action = p.action && typeof p.action === 'object' ? (p.action as Record<string, unknown>) : null
      const query = typeof action?.query === 'string' ? action.query : ''
      return toMessages(uid, 'assistant', [{ kind: 'tool', name: 'web_search', input: capEnd(query, TOOL_INPUT_CAP) }], ts)
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const { text, images } = collectResultContent(p.output)
      const result: ToolResultBlock = {
        kind: 'toolResult',
        output: truncateMiddle(text, TOOL_RESULT_CAP, TOOL_RESULT_HEAD, TOOL_RESULT_TAIL),
      }
      if (typeof p.call_id === 'string') result.forId = p.call_id
      const blocks: ChatBlock[] = [result]
      for (let i = 0; i < images; i++) blocks.push({ kind: 'image' })
      return toMessages(uid, 'tool', blocks, ts)
    }
    default:
      return []
  }
}
