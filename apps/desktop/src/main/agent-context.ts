// How full is this agent's context window?
//
// Both CLIs already write the answer to their transcript on every turn — we just
// have to read the last one. Neither exposes it any other way (no IPC, no status
// file), so the transcript tail is the only source, and it is a cheap one: the
// numbers live in the newest records, so a fixed tail read answers it regardless
// of how many megabytes the session has accumulated.
//
//   Claude: ~/.claude/projects/<slugified-cwd>/<claudeSessionId>.jsonl
//           …the last assistant message's `message.usage`.
//   Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<sessionId>.jsonl
//           …the last `event_msg` of type `token_count`, which carries both the
//           usage AND the window size codex negotiated for the model.
//
// Kept free of Electron and of any long-lived state so it can be unit-tested;
// the file watching and the per-session bookkeeping live in
// agent-context-tracker.ts.

import * as path from 'node:path'

/** What the phone's session cards render: a fraction of a context window. */
export interface ContextUsage {
  /** Tokens currently occupying the model's context window. */
  usedTokens: number
  /** The window those tokens are measured against. */
  contextWindow: number
}

/**
 * Claude's default window. Claude Code does not record the negotiated window
 * anywhere in the transcript — only the usage — so it has to be inferred, and
 * everything but the long-context variants is 200k.
 */
export const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000

/** …and the long-context variants (`claude-opus-5[1m]` and friends). */
export const CLAUDE_LONG_CONTEXT_WINDOW = 1_000_000

/**
 * Which window a Claude transcript's usage should be read against.
 *
 * The model id in the transcript is the *base* id — a session running the 1M
 * variant still records `claude-opus-5` — so the id alone can't be trusted to
 * rule the long window out. The observed usage can rule it *in*, though: tokens
 * past 200k could not have fit in the small window. That makes the answer
 * self-correcting rather than merely optimistic — a long-context session reads
 * as a nearly-full 200k window until it crosses the line, and is right from then
 * on. Erring this way (rather than defaulting everything to 1M) keeps the common
 * case exact, since the great majority of sessions never leave the small window.
 */
export function claudeContextWindow(model: string | null, usedTokens: number): number {
  const id = (model ?? '').toLowerCase()
  if (id.includes('[1m]') || id.includes('-1m')) return CLAUDE_LONG_CONTEXT_WINDOW
  if (usedTokens > CLAUDE_DEFAULT_CONTEXT_WINDOW) return CLAUDE_LONG_CONTEXT_WINDOW
  return CLAUDE_DEFAULT_CONTEXT_WINDOW
}

/** Every line of a tail read except a leading partial one (see readTail). */
function completeLines(tail: string, partial: boolean): string[] {
  const lines = tail.split('\n')
  if (partial) lines.shift()
  return lines
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * The context occupancy recorded by the last assistant message in a Claude
 * transcript tail, or null when the tail holds none.
 *
 * The window is occupied by everything the request *sent* — fresh input, the
 * cache it wrote, and the cache it read — plus what the model wrote back, which
 * is already in the context by the time the next turn starts. Anthropic bills
 * these separately, so they are separate fields; for occupancy they simply add.
 *
 * Scanned bottom-up and stopped at the first hit: only the newest turn describes
 * the context as it stands now (earlier turns describe a smaller conversation,
 * and a compaction makes them describe one that no longer exists).
 */
export function parseClaudeContextTail(tail: string, partial: boolean): ContextUsage | null {
  const lines = completeLines(tail, partial)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const message = (parsed as { message?: unknown })?.message as
      | { usage?: Record<string, unknown>; model?: unknown }
      | undefined
    const usage = message?.usage
    if (!usage || typeof usage !== 'object') continue
    const usedTokens =
      num(usage.input_tokens) +
      num(usage.cache_creation_input_tokens) +
      num(usage.cache_read_input_tokens) +
      num(usage.output_tokens)
    if (usedTokens <= 0) continue
    const model = typeof message?.model === 'string' ? message.model : null
    return { usedTokens, contextWindow: claudeContextWindow(model, usedTokens) }
  }
  return null
}

/**
 * The context occupancy recorded by the last `token_count` event in a codex
 * rollout tail, or null when the tail holds none.
 *
 * Codex reports two usages per event: `total_token_usage` accumulates across
 * every turn of the session (so it runs far past the window and is a cost
 * figure, not an occupancy one), and `last_token_usage` describes the single
 * most recent request — whose input *is* the whole conversation. The latter is
 * the one that answers "how full is the window", and codex hands us the window
 * itself in the same object, so nothing has to be inferred here.
 */
export function parseCodexContextTail(tail: string, partial: boolean): ContextUsage | null {
  const lines = completeLines(tail, partial)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const obj = parsed as { type?: unknown; payload?: unknown }
    if (obj.type !== 'event_msg' || !obj.payload || typeof obj.payload !== 'object') continue
    const payload = obj.payload as { type?: unknown; info?: unknown }
    if (payload.type !== 'token_count' || !payload.info || typeof payload.info !== 'object') continue
    const info = payload.info as { last_token_usage?: Record<string, unknown>; model_context_window?: unknown }
    const contextWindow = num(info.model_context_window)
    const usedTokens = num(info.last_token_usage?.total_tokens)
    if (!contextWindow || !usedTokens) continue
    return { usedTokens, contextWindow }
  }
  return null
}

/**
 * The directory Claude Code writes a session's transcript into, which is the
 * working directory with every non-alphanumeric run collapsed to a single dash
 * (so `/Users/x/Tedy/orchestra` becomes `-Users-x-Tedy-orchestra`).
 */
export function claudeProjectDir(cwd: string, home: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-')
  return path.join(home, '.claude', 'projects', slug)
}

/**
 * Pick a session's transcript out of a project directory listing: the most
 * recently written `.jsonl` that no other session has already claimed.
 *
 * Claude's hook payload carries the authoritative path, and the tracker prefers
 * it whenever a hook has fired. This is the cold-start fallback for the window
 * before that happens (and for sessions whose hooks aren't installed), where the
 * only thing tying an orchestra session to a transcript is the directory they
 * share. Two agents in one worktree can be mispaired by it — the exclusion set
 * keeps them from collapsing onto the *same* transcript, and the hook path
 * corrects the pairing as soon as either one takes a turn.
 */
export function pickClaudeTranscript(
  entries: { name: string; mtimeMs: number }[],
  claimed: ReadonlySet<string>,
): string | null {
  let best: { name: string; mtimeMs: number } | null = null
  for (const entry of entries) {
    if (!entry.name.endsWith('.jsonl')) continue
    if (claimed.has(entry.name)) continue
    if (best && entry.mtimeMs <= best.mtimeMs) continue
    best = entry
  }
  return best?.name ?? null
}
