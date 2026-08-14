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
  /**
   * The model and reasoning effort the session is currently running, as the
   * CLI itself records them (claude: `claude-fable-5` / `xhigh`; codex:
   * `gpt-5.6-sol` / `high`). The phone's model picker renders these as the
   * session's current values. Absent when the tail doesn't record them.
   */
  model?: string
  effort?: string
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
    // The record also stamps the session's reasoning effort at the top level.
    const effort = (parsed as { effort?: unknown }).effort
    return {
      usedTokens,
      contextWindow: claudeContextWindow(model, usedTokens),
      ...(model ? { model } : {}),
      ...(typeof effort === 'string' && effort ? { effort } : {}),
    }
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
 *
 * The model and effort live in a different record: codex opens every turn with
 * a `turn_context` whose payload carries both, so the same bottom-up scan keeps
 * the newest of each and stops once it has both. A tail with usage but no
 * turn_context still answers the occupancy question, just without model info.
 */
export function parseCodexContextTail(tail: string, partial: boolean): ContextUsage | null {
  const lines = completeLines(tail, partial)
  let usage: { usedTokens: number; contextWindow: number } | null = null
  let turn: { model?: string; effort?: string } | null = null
  for (let i = lines.length - 1; i >= 0 && !(usage && turn); i--) {
    const line = lines[i]?.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const obj = parsed as { type?: unknown; payload?: unknown }
    if (!obj.payload || typeof obj.payload !== 'object') continue
    if (!turn && obj.type === 'turn_context') {
      const payload = obj.payload as { model?: unknown; effort?: unknown }
      turn = {
        ...(typeof payload.model === 'string' && payload.model ? { model: payload.model } : {}),
        ...(typeof payload.effort === 'string' && payload.effort ? { effort: payload.effort } : {}),
      }
      continue
    }
    if (usage || obj.type !== 'event_msg') continue
    const payload = obj.payload as { type?: unknown; info?: unknown }
    if (payload.type !== 'token_count' || !payload.info || typeof payload.info !== 'object') continue
    const info = payload.info as { last_token_usage?: Record<string, unknown>; model_context_window?: unknown }
    const contextWindow = num(info.model_context_window)
    const usedTokens = num(info.last_token_usage?.total_tokens)
    if (!contextWindow || !usedTokens) continue
    usage = { usedTokens, contextWindow }
  }
  return usage ? { ...usage, ...turn } : null
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
export interface TranscriptCandidate {
  name: string
  mtimeMs: number
  /**
   * When the file was CREATED. A conversation that already existed when a
   * session launched cannot be that session's transcript, which is the one
   * thing mtime can never tell us: a foreign conversation being written right
   * now looks fresher than the true one. Optional — where the platform records
   * no birth time the caller passes mtime and the floor degrades to "has been
   * touched since the session started".
   */
  createdMs?: number
}

/**
 * How long a fresh claude session waits for a hook-reported transcript before
 * the cwd guess below may fire at all. SessionStart reports the real path
 * within a couple of seconds of launch; guessing inside that window attaches
 * whatever conversation happens to be newest.
 */
export const CLAUDE_GUESS_GRACE_MS = 5_000

/**
 * Sessions tracked within this of the process starting are pre-existing ones
 * being re-adopted (a desktop restart re-tracks every running agent at once),
 * not new launches — their transcripts are rightly older than the tracking, so
 * the floor below must not apply to them.
 */
const COLD_START_MS = 20_000

/**
 * Backdating slack on the floor. A session enters tracking when its OSC title
 * identifies the agent, which can trail claude writing its first record by a
 * few seconds either way; the floor only has to exclude conversations from
 * BEFORE this session existed, so it can afford to be generous.
 */
const GUESS_BIRTH_SLACK_MS = 30_000

/**
 * The earliest a transcript may have been created and still be a candidate for
 * this session's cold-start guess — or undefined for "no floor".
 *
 * Why this exists: a fresh claude session has no transcript for the first
 * seconds of its life (longer when claude sits on its trust-this-folder
 * prompt, which blocks startup — and therefore SessionStart — until the user
 * answers). Unfloored, the guess hands that session the newest OTHER
 * conversation in the project directory: the phone and the desktop render a
 * foreign chat and a foreign context figure, and the correction, when the real
 * pairing finally lands, arrives as a conversation SWAP that clears the rows
 * already shown. Both halves of the bug reported 2026-08-14.
 *
 * A session that appeared after this process settled must have a transcript
 * created at roughly its own launch time, so anything older is provably not
 * it. Re-adopted sessions (cold start) keep the old unfloored behaviour: their
 * conversations legitimately predate tracking, and the guess is the only
 * pairing a hook-silent one will ever get.
 *
 * The one thing this floor deliberately excludes is a RESUME — a resumed
 * conversation is old by definition, however freshly it is being written. That
 * is not a hole: a resume names its conversation, so `pairResumedTranscripts`
 * (remote-bridge.ts) looks the file up exactly and feeds it through the same
 * authoritative channel the hooks use, before any guess is reached. Don't
 * loosen the floor to cover resumes — fix that lookup instead.
 */
export function transcriptGuessFloor(
  processStartedAt: number,
  trackedAt: number,
): number | undefined {
  if (trackedAt - processStartedAt < COLD_START_MS) return undefined
  return trackedAt - GUESS_BIRTH_SLACK_MS
}

export function pickClaudeTranscript(
  entries: TranscriptCandidate[],
  claimed: ReadonlySet<string>,
  minCreatedMs?: number,
): string | null {
  let best: TranscriptCandidate | null = null
  for (const entry of entries) {
    if (!entry.name.endsWith('.jsonl')) continue
    if (claimed.has(entry.name)) continue
    // Earliest evidence the file existed: an old mtime proves it as surely as
    // an old birth time, and a live foreign conversation has only the latter.
    if (minCreatedMs != null && Math.min(entry.createdMs ?? Infinity, entry.mtimeMs) < minCreatedMs)
      continue
    if (best && entry.mtimeMs <= best.mtimeMs) continue
    best = entry
  }
  return best?.name ?? null
}

/**
 * The whole cold-start fallback around pickClaudeTranscript, shared by both of
 * its consumers (the context tracker and the message mirror): reduce the other
 * sessions' resolved transcripts to a claim set for this directory, weigh the
 * `.jsonl` candidates by mtime, and pick the freshest unclaimed one. Extracted
 * because the two had grown near-verbatim copies of this scan, and a fix to
 * the claim bookkeeping in one would silently miss the other.
 *
 * Kept fs-free like the rest of this module: the caller lists the directory
 * and answers the mtime question through the accessor. Answering null (the
 * file vanished between the listing and the stat) just drops that candidate —
 * transcripts are deleted out from under us routinely (worktree removal,
 * history clears), so that race is a normal operating condition. The accessor
 * may answer with a bare mtime or with `{mtimeMs, createdMs}`; only the second
 * form can be floored (see transcriptGuessFloor).
 */
export function findClaudeTranscript(
  dir: string,
  names: string[],
  stat: (name: string) => number | { mtimeMs: number; createdMs?: number } | null,
  claimedPaths: Iterable<string>,
  minCreatedMs?: number,
): string | null {
  const claimed = new Set<string>()
  for (const file of claimedPaths) {
    if (path.dirname(file) === dir) claimed.add(path.basename(file))
  }
  const entries: TranscriptCandidate[] = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const got = stat(name)
    if (got == null) continue
    entries.push(
      typeof got === 'number'
        ? { name, mtimeMs: got }
        : { name, mtimeMs: got.mtimeMs, createdMs: got.createdMs },
    )
  }
  const pick = pickClaudeTranscript(entries, claimed, minCreatedMs)
  return pick ? path.join(dir, pick) : null
}
