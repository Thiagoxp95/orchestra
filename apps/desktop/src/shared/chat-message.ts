// The chat wire model: what every chat surface (desktop renderer, web) renders.
// Produced main-side by agent-message-model and the native-chat adapters.

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
  // standalone. `answers` is AskUserQuestion's structured question→choice list,
  // lifted from the transcript record's toolUseResult. A LIST of pairs, never a
  // map keyed by the question text: Convex validates object field names on the
  // client (`convexToJson`) and rejects any key holding a non-ASCII character
  // (an em dash), a `$` prefix, or a control char — and a rejected batch is
  // retried unchanged forever, which froze the phone's chat at exactly the
  // answered question (2026-08-12 and 2026-08-15, both em dashes). Question
  // text is content; content never becomes a field name.
  | { kind: 'toolResult'; forId?: string; output: string; isError?: boolean; answers?: QuestionAnswer[] }
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

/** One answered question: the question text and the recorded choice/free text. */
export type QuestionAnswer = { question: string; answer: string }

export type ChatMessage = {
  /** Stable identity: Claude record uuid; Codex `<fileBase>:<lineNo>`. */
  uid: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  blocks: ChatBlock[]
  /** ms epoch from the transcript timestamp, when present. */
  ts?: number
  /** Set when this record belongs to a SUBAGENT: the id of the Task tool call
   *  that spawned it (the SDK's `parent_tool_use_id`). The chat pane nests
   *  these under that call instead of interleaving them into the transcript. */
  parentToolUseId?: string
}
