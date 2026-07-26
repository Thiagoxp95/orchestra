// Reads the transcript files Claude Code and Codex write on disk so the UI can
// offer "resume that session I just closed by accident".
//
//   Claude: ~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl
//   Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<sessionId>.jsonl
//
// Both formats are append-only JSONL, and both can run into the megabytes, so we
// never read a whole transcript: the newest records live at the end, so a tail
// read is enough for the title/last message. Codex additionally keeps its
// session metadata (cwd, session id) on the first line, which we read
// separately with a cap because that line embeds the full system prompt.
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RecentAgentSession } from '../shared/types'

const TAIL_BYTES = 256 * 1024
/**
 * Head window for codex rollouts. It has to clear the session_meta line, which
 * embeds base_instructions (routinely 20-30KB), and reach the opening prompt.
 */
const HEAD_BYTES = 512 * 1024
/** Fallback cap when a single session_meta line overruns the head window. */
const META_LINE_CAP_BYTES = 4 * 1024 * 1024
/** Transcripts below this can't hold a real exchange (metadata-only stubs). */
const MIN_TRANSCRIPT_BYTES = 512
/**
 * Sessions returned per agent. This is what the picker can filter over, so it has
 * to cover every workspace and worktree worked in recently — not just the last
 * handful. It used to be 12 (24 rows total), which meant a couple of busy
 * repositories crowded every other workspace out of the list entirely.
 *
 * The cost of a high cap is bounded and small: a tail read plus a JSON parse per
 * transcript, run concurrently — a fortnight of heavy use (~400 transcripts)
 * lands in ~200ms.
 */
const DEFAULT_LIMIT = 250
const DEFAULT_MAX_AGE_DAYS = 30
/** Cap the parse work when the newest transcripts turn out to be unusable. */
const PARSE_BUDGET_MULTIPLIER = 4
/** Transcripts parsed in flight. Disk-bound work, so well above the core count. */
const PARSE_CONCURRENCY = 24

export interface ListRecentAgentSessionsOptions {
  /** Max sessions returned per agent (default 12). */
  limit?: number
  /** Ignore transcripts older than this (default 14 days). */
  maxAgeDays?: number
  claudeRoot?: string
  codexRoot?: string
}

interface Candidate {
  filePath: string
  mtimeMs: number
  size: number
}

/** Collapse whitespace and clip, so a summary fits on a couple of UI lines. */
export function summarize(text: string | undefined | null, maxLength = 240): string | null {
  if (!text) return null
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  if (flat.length <= maxLength) return flat
  return `${flat.slice(0, maxLength - 1).trimEnd()}…`
}

/**
 * Claude records the user side of tool loops and slash-command plumbing as
 * `user` entries too. Those aren't things a human typed, so they'd make a
 * misleading summary.
 */
function isSyntheticUserText(text: string): boolean {
  const trimmed = text.trimStart()
  return (
    trimmed.startsWith('<command-name>')
    || trimmed.startsWith('<command-message>')
    || trimmed.startsWith('<local-command-stdout>')
    || trimmed.startsWith('<system-reminder>')
    || trimmed.startsWith('<user-prompt-submit-hook>')
    || trimmed.startsWith('Caveat: The messages below were generated')
  )
}

function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

export interface ParsedClaudeTranscript {
  sessionId?: string
  cwd?: string
  gitBranch?: string
  /** Claude's own AI-generated conversation title, when it has written one. */
  title?: string
  lastUserMessage?: string
  lastAssistantMessage?: string
  lastActivityAt?: number
  hasMessages: boolean
}

/**
 * Parse the tail of a Claude transcript. `partial` marks that the first line is
 * a fragment of a record that started before the read window, so it's dropped.
 */
export function parseClaudeTranscriptTail(tail: string, partial: boolean): ParsedClaudeTranscript {
  const result: ParsedClaudeTranscript = { hasMessages: false }
  const lines = tail.split('\n')
  if (partial) lines.shift()
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof entry.sessionId === 'string') result.sessionId = entry.sessionId
    if (typeof entry.cwd === 'string') result.cwd = entry.cwd
    if (typeof entry.gitBranch === 'string') result.gitBranch = entry.gitBranch

    const type = entry.type
    if (type === 'ai-title' && typeof entry.aiTitle === 'string') {
      result.title = entry.aiTitle
      continue
    }
    // Sub-agent turns are a different conversation than the one being resumed.
    if (entry.isSidechain === true) continue
    if (type !== 'user' && type !== 'assistant') continue
    const text = messageText(entry.message).trim()
    if (!text) continue
    if (type === 'user') {
      if (entry.isMeta === true || isSyntheticUserText(text)) continue
      result.lastUserMessage = text
    } else {
      result.lastAssistantMessage = text
    }
    result.hasMessages = true
    const ts = parseTimestamp(entry.timestamp)
    if (ts) result.lastActivityAt = ts
  }
  return result
}

export interface ParsedCodexMeta {
  sessionId?: string
  cwd?: string
  startedAt?: number
  /** Codex marks rollouts written by spawned sub-workers as `subagent`. */
  isSubagent: boolean
}

export function parseCodexSessionMeta(firstLine: string): ParsedCodexMeta | null {
  let entry: { type?: unknown; payload?: Record<string, unknown> }
  try {
    entry = JSON.parse(firstLine) as { type?: unknown; payload?: Record<string, unknown> }
  } catch {
    return null
  }
  if (entry.type !== 'session_meta' || !entry.payload) return null
  const payload = entry.payload
  return {
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
    startedAt: parseTimestamp(payload.timestamp),
    isSubagent: payload.thread_source === 'subagent' || typeof payload.parent_thread_id === 'string',
  }
}

/**
 * Codex Desktop wraps a prompt in an attachment preamble and puts what the
 * person actually typed after a marker. Strip back down to the request; an
 * attachment-only turn (the request lives in the attached file) has nothing
 * worth showing.
 */
export function normalizeCodexUserMessage(raw: string): string | null {
  const marker = '## My request for Codex:'
  let text = raw.trim()
  const markerIndex = text.lastIndexOf(marker)
  if (markerIndex !== -1) {
    text = text.slice(markerIndex + marker.length).trim()
  } else if (text.startsWith('# Files mentioned by the user:')) {
    return null
  }
  if (!text || isSyntheticUserText(text)) return null
  return text
}

/** First human prompt of a codex rollout — the best title we can give it. */
export function findFirstCodexUserMessage(head: string, dropLastLine: boolean): string | null {
  const lines = head.split('\n')
  if (dropLastLine) lines.pop()
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: { type?: unknown; payload?: Record<string, unknown> }
    try {
      entry = JSON.parse(trimmed) as { type?: unknown; payload?: Record<string, unknown> }
    } catch {
      continue
    }
    if (entry.type !== 'event_msg') continue
    const payload = entry.payload
    if (!payload || payload.type !== 'user_message' || typeof payload.message !== 'string') continue
    const text = normalizeCodexUserMessage(payload.message)
    if (text) return text
  }
  return null
}

export interface ParsedCodexTranscript {
  lastUserMessage?: string
  lastAssistantMessage?: string
  lastActivityAt?: number
  hasMessages: boolean
}

export function parseCodexTranscriptTail(tail: string, partial: boolean): ParsedCodexTranscript {
  const result: ParsedCodexTranscript = { hasMessages: false }
  const lines = tail.split('\n')
  if (partial) lines.shift()
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: { type?: unknown; timestamp?: unknown; payload?: Record<string, unknown> }
    try {
      entry = JSON.parse(trimmed) as { type?: unknown; timestamp?: unknown; payload?: Record<string, unknown> }
    } catch {
      continue
    }
    if (entry.type !== 'event_msg' || !entry.payload) continue
    const payload = entry.payload
    let text: string | undefined | null
    if (payload.type === 'user_message' && typeof payload.message === 'string') {
      text = normalizeCodexUserMessage(payload.message)
      if (!text) continue
      result.lastUserMessage = text
    } else if (payload.type === 'agent_message' && typeof payload.message === 'string') {
      text = payload.message.trim()
      if (!text) continue
      result.lastAssistantMessage = text
    } else if (payload.type === 'task_complete' && typeof payload.last_agent_message === 'string') {
      text = payload.last_agent_message.trim()
      if (!text) continue
      result.lastAssistantMessage = text
    } else {
      continue
    }
    result.hasMessages = true
    const ts = parseTimestamp(entry.timestamp)
    if (ts) result.lastActivityAt = ts
  }
  return result
}

/** Read the last `bytes` of a file; `partial` is true when the head was skipped. */
async function readTail(filePath: string, bytes: number): Promise<{ text: string; partial: boolean } | null> {
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return null
  }
  try {
    const info = await handle.stat()
    const start = Math.max(0, info.size - bytes)
    const length = info.size - start
    if (length <= 0) return { text: '', partial: false }
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), partial: start > 0 }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Read the first `bytes` of a file; `truncated` means more file followed. */
async function readHead(filePath: string, bytes: number): Promise<{ text: string; truncated: boolean } | null> {
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return null
  }
  try {
    const info = await handle.stat()
    const length = Math.min(bytes, info.size)
    if (length <= 0) return { text: '', truncated: false }
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: info.size > bytesRead }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Read up to the first newline, capped so a corrupt file can't be slurped whole. */
async function readFirstLine(filePath: string, capBytes: number): Promise<string | null> {
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return null
  }
  try {
    const chunkSize = 64 * 1024
    const buffer = Buffer.allocUnsafe(chunkSize)
    let combined = ''
    let offset = 0
    while (offset < capBytes) {
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, offset)
      if (bytesRead === 0) return combined.length > 0 ? combined : null
      combined += buffer.subarray(0, bytesRead).toString('utf8')
      const newline = combined.indexOf('\n')
      if (newline !== -1) return combined.slice(0, newline)
      offset += bytesRead
    }
    return null
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

async function statCandidate(filePath: string, cutoff: number): Promise<Candidate | null> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return null
    if (info.mtimeMs < cutoff) return null
    if (info.size < MIN_TRANSCRIPT_BYTES) return null
    return { filePath, mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    return null
  }
}

async function collectClaudeCandidates(root: string, cutoff: number): Promise<Candidate[]> {
  let projectDirs: string[]
  try {
    projectDirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
  } catch {
    return []
  }
  const candidates: Candidate[] = []
  await Promise.all(
    projectDirs.map(async (dir) => {
      let files: string[]
      try {
        files = (await readdir(dir, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
          .map((entry) => join(dir, entry.name))
      } catch {
        return
      }
      const stats = await Promise.all(files.map((file) => statCandidate(file, cutoff)))
      for (const candidate of stats) if (candidate) candidates.push(candidate)
    }),
  )
  return candidates
}

async function collectCodexCandidates(root: string, cutoff: number): Promise<Candidate[]> {
  // Codex buckets rollouts under YYYY/MM/DD. Discover the directories rather
  // than computing dates so clock skew / timezone can't skip a day.
  const dayDirs: string[] = []
  let years: string[]
  try {
    years = (await readdir(root)).filter((name) => /^\d{4}$/.test(name)).sort().reverse()
  } catch {
    return []
  }
  const maxDayDirs = Math.max(2, Math.ceil((Date.now() - cutoff) / (24 * 60 * 60 * 1000)) + 1)
  outer: for (const year of years) {
    let months: string[]
    try {
      months = (await readdir(join(root, year))).filter((name) => /^\d{2}$/.test(name)).sort().reverse()
    } catch {
      continue
    }
    for (const month of months) {
      let days: string[]
      try {
        days = (await readdir(join(root, year, month))).filter((name) => /^\d{2}$/.test(name)).sort().reverse()
      } catch {
        continue
      }
      for (const day of days) {
        dayDirs.push(join(root, year, month, day))
        if (dayDirs.length >= maxDayDirs) break outer
      }
    }
  }
  const candidates: Candidate[] = []
  await Promise.all(
    dayDirs.map(async (dir) => {
      let files: string[]
      try {
        files = (await readdir(dir, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl'))
          .map((entry) => join(dir, entry.name))
      } catch {
        return
      }
      const stats = await Promise.all(files.map((file) => statCandidate(file, cutoff)))
      for (const candidate of stats) if (candidate) candidates.push(candidate)
    }),
  )
  return candidates
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** `rollout-<ISO timestamp>-<uuid>.jsonl` — the id is a deterministic suffix. */
function codexSessionIdFromFileName(filePath: string): string | null {
  const base = filePath.split('/').pop() ?? ''
  const match = base.match(/^rollout-.*?-([0-9a-fA-F-]{36})\.jsonl$/)
  return match?.[1] ?? null
}

async function buildClaudeEntry(candidate: Candidate): Promise<RecentAgentSession | null> {
  const tail = await readTail(candidate.filePath, TAIL_BYTES)
  if (!tail) return null
  const parsed = parseClaudeTranscriptTail(tail.text, tail.partial)
  if (!parsed.hasMessages) return null
  const sessionId = parsed.sessionId ?? candidate.filePath.split('/').pop()?.replace(/\.jsonl$/, '')
  if (!sessionId) return null
  const cwd = parsed.cwd ?? ''
  if (!cwd) return null
  return {
    agent: 'claude',
    sessionId,
    filePath: candidate.filePath,
    cwd,
    cwdExists: await dirExists(cwd),
    gitBranch: parsed.gitBranch ?? null,
    updatedAt: parsed.lastActivityAt ?? candidate.mtimeMs,
    title: summarize(parsed.title, 90) ?? summarize(parsed.lastUserMessage, 90),
    lastUserMessage: summarize(parsed.lastUserMessage),
    lastAssistantMessage: summarize(parsed.lastAssistantMessage),
  }
}

async function buildCodexEntry(candidate: Candidate): Promise<RecentAgentSession | null> {
  // One head read covers both things that live at the top of a rollout: the
  // session_meta line and the opening prompt, which titles the session better
  // than whatever was said most recently.
  const head = await readHead(candidate.filePath, HEAD_BYTES)
  if (!head) return null
  const firstNewline = head.text.indexOf('\n')
  const firstLine = firstNewline === -1
    ? await readFirstLine(candidate.filePath, META_LINE_CAP_BYTES)
    : head.text.slice(0, firstNewline)
  const meta = firstLine ? parseCodexSessionMeta(firstLine) : null
  if (!meta || meta.isSubagent) return null
  const sessionId = meta.sessionId ?? codexSessionIdFromFileName(candidate.filePath)
  if (!sessionId || !meta.cwd) return null
  const tail = await readTail(candidate.filePath, TAIL_BYTES)
  if (!tail) return null
  const parsed = parseCodexTranscriptTail(tail.text, tail.partial)
  if (!parsed.hasMessages) return null
  const firstPrompt = firstNewline === -1
    ? null
    : findFirstCodexUserMessage(head.text.slice(firstNewline + 1), head.truncated)
  return {
    agent: 'codex',
    sessionId,
    filePath: candidate.filePath,
    cwd: meta.cwd,
    cwdExists: await dirExists(meta.cwd),
    gitBranch: null,
    updatedAt: parsed.lastActivityAt ?? candidate.mtimeMs,
    title: summarize(firstPrompt ?? parsed.lastUserMessage, 90),
    lastUserMessage: summarize(parsed.lastUserMessage),
    lastAssistantMessage: summarize(parsed.lastAssistantMessage),
  }
}

/**
 * Walk candidates newest-first, parsing until `limit` usable sessions are found.
 * Transcripts get skipped for a few reasons (metadata-only stubs, codex
 * sub-worker rollouts, unparseable tails), so the budget bounds the work when
 * the newest files are all duds.
 *
 * Parsed a batch at a time rather than one file after another: this is pure I/O
 * wait, and at the limits above a serial walk would take seconds where the
 * concurrent one takes a fraction of one. Batch results are consumed in mtime
 * order, so overshooting the limit inside a batch still keeps the newest.
 */
async function takeNewest(
  candidates: Candidate[],
  limit: number,
  build: (candidate: Candidate) => Promise<RecentAgentSession | null>,
): Promise<RecentAgentSession[]> {
  const ordered = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs)
  const budget = Math.min(ordered.length, limit * PARSE_BUDGET_MULTIPLIER + 10)
  const entries: RecentAgentSession[] = []
  const seen = new Set<string>()
  for (let i = 0; i < budget && entries.length < limit; i += PARSE_CONCURRENCY) {
    const batch = ordered.slice(i, Math.min(i + PARSE_CONCURRENCY, budget))
    const built = await Promise.all(batch.map((candidate) => build(candidate)))
    for (const entry of built) {
      if (!entry || seen.has(entry.sessionId)) continue
      seen.add(entry.sessionId)
      entries.push(entry)
    }
  }
  return entries.length > limit ? entries.slice(0, limit) : entries
}

export async function listRecentAgentSessions(
  opts: ListRecentAgentSessionsOptions = {},
): Promise<RecentAgentSession[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT
  const cutoff = Date.now() - (opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000
  const claudeRoot = opts.claudeRoot ?? join(homedir(), '.claude', 'projects')
  const codexRoot = opts.codexRoot ?? join(homedir(), '.codex', 'sessions')

  const [claudeCandidates, codexCandidates] = await Promise.all([
    collectClaudeCandidates(claudeRoot, cutoff),
    collectCodexCandidates(codexRoot, cutoff),
  ])
  const [claude, codex] = await Promise.all([
    takeNewest(claudeCandidates, limit, buildClaudeEntry),
    takeNewest(codexCandidates, limit, buildCodexEntry),
  ])
  return [...claude, ...codex].sort((a, b) => b.updatedAt - a.updatedAt)
}
