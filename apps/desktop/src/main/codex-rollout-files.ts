import * as fs from 'node:fs'
import * as path from 'node:path'

export interface CodexRolloutMatch {
  path: string
  threadId: string
}

export interface CodexRolloutLookupOptions {
  promptHints?: string[]
}

interface CodexRolloutMeta {
  cwd: string
  threadId: string
  startedAt: number | null
}

interface CodexRolloutCandidate extends CodexRolloutMatch {
  mtime: number
  startedAt: number
}

const CODEX_ROLLOUT_START_GRACE_MS = 5_000
const CODEX_ROLLOUT_META_CHUNK_BYTES = 4_096
const CODEX_ROLLOUT_META_MAX_BYTES = 256 * 1024

export function findCodexRolloutByDirectory(
  rootDir: string,
  cwd: string,
  sessionCreatedAt: number,
  options: CodexRolloutLookupOptions = {},
): CodexRolloutMatch | null {
  try {
    const candidates: CodexRolloutCandidate[] = []

    for (const filePath of listCodexRolloutPaths(rootDir)) {
      try {
        const stat = fs.statSync(filePath)

        const meta = readCodexRolloutMeta(filePath)
        if (!meta || meta.cwd !== cwd) continue
        const startedAt = meta.startedAt ?? stat.mtimeMs
        if (startedAt < sessionCreatedAt - CODEX_ROLLOUT_START_GRACE_MS) continue

        candidates.push({
          path: filePath,
          threadId: meta.threadId,
          mtime: stat.mtimeMs,
          startedAt,
        })
      } catch {
        continue
      }
    }

    const bestMatch = pickCodexRolloutCandidate(candidates, sessionCreatedAt, options)
    return bestMatch ? { path: bestMatch.path, threadId: bestMatch.threadId } : null
  } catch {
    return null
  }
}

export function listCodexRolloutPaths(rootDir: string): string[] {
  return collectCodexRolloutPaths(rootDir)
}

function collectCodexRolloutPaths(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const paths: string[] = []

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      paths.push(...collectCodexRolloutPaths(fullPath))
      continue
    }

    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      paths.push(fullPath)
    }
  }

  return paths
}

function rankCodexRolloutCandidates(
  candidates: CodexRolloutCandidate[],
  sessionCreatedAt: number,
): CodexRolloutCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftDistance = Math.abs(left.startedAt - sessionCreatedAt)
    const rightDistance = Math.abs(right.startedAt - sessionCreatedAt)
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance
    }

    return right.mtime - left.mtime
  })
}

function pickCodexRolloutCandidate(
  candidates: CodexRolloutCandidate[],
  sessionCreatedAt: number,
  options: CodexRolloutLookupOptions,
): CodexRolloutCandidate | null {
  const ranked = rankCodexRolloutCandidates(candidates, sessionCreatedAt)
  if (ranked.length === 0) return null

  const promptHints = normalizePromptHints(options.promptHints ?? [])
  if (promptHints.length === 0) {
    return ranked.length === 1 ? ranked[0] : null
  }

  const matchingCandidates = ranked.filter((candidate) => doesCodexRolloutMatchPromptHints(candidate.path, promptHints))
  return matchingCandidates.length === 1 ? matchingCandidates[0] : null
}

export function doesCodexRolloutMatchPromptHints(filePath: string, promptHints: string[]): boolean {
  const normalizedHints = normalizePromptHints(promptHints)
  if (normalizedHints.length === 0) return true

  const rolloutPrompts = readCodexRolloutPromptTexts(filePath)
  if (rolloutPrompts.length === 0) return false

  return rolloutPrompts.some((prompt) => normalizedHints.includes(prompt))
}

function readCodexRolloutMeta(filePath: string): CodexRolloutMeta | null {
  let fd: number | null = null

  try {
    fd = fs.openSync(filePath, 'r')
    const firstLine = readFirstLine(fd)
    if (!firstLine) return null

    const entry = JSON.parse(firstLine)
    const threadId = entry?.payload?.id
    const cwd = entry?.payload?.cwd
    if (typeof threadId !== 'string' || !threadId) return null
    if (typeof cwd !== 'string' || !cwd) return null

    return {
      cwd,
      threadId,
      startedAt: parseCodexTimestamp(entry?.payload?.timestamp) ?? parseCodexTimestamp(entry?.timestamp),
    }
  } catch {
    return null
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
  }
}

function readFirstLine(fd: number): string {
  const chunks: Buffer[] = []
  let offset = 0

  while (offset < CODEX_ROLLOUT_META_MAX_BYTES) {
    const nextChunkSize = Math.min(CODEX_ROLLOUT_META_CHUNK_BYTES, CODEX_ROLLOUT_META_MAX_BYTES - offset)
    const buffer = Buffer.alloc(nextChunkSize)
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset)
    if (bytesRead <= 0) break

    const chunk = buffer.subarray(0, bytesRead)
    const newlineIndex = chunk.indexOf(0x0a)
    if (newlineIndex >= 0) {
      chunks.push(chunk.subarray(0, newlineIndex))
      break
    }

    chunks.push(chunk)
    offset += bytesRead
  }

  return Buffer.concat(chunks).toString('utf8').trim()
}

function parseCodexTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function normalizePromptHints(promptHints: string[]): string[] {
  const hints: string[] = []
  const seen = new Set<string>()

  for (const promptHint of promptHints) {
    const normalized = normalizePrompt(promptHint)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    hints.push(normalized)
  }

  return hints
}

function normalizePrompt(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function readCodexRolloutPromptTexts(filePath: string): string[] {
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    const prompts: string[] = []
    const seen = new Set<string>()

    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let entry: any
      try {
        entry = JSON.parse(trimmed)
      } catch {
        continue
      }

      for (const prompt of extractCodexRolloutPromptTexts(entry)) {
        const normalized = normalizePrompt(prompt)
        if (!normalized || seen.has(normalized)) continue
        seen.add(normalized)
        prompts.push(normalized)
      }
    }

    return prompts
  } catch {
    return []
  }
}

function extractCodexRolloutPromptTexts(entry: any): string[] {
  if (entry?.type === 'event_msg' && entry?.payload?.type === 'user_message') {
    return typeof entry?.payload?.message === 'string' ? [entry.payload.message] : []
  }

  if (entry?.type !== 'response_item') return []
  if (entry?.payload?.type !== 'message' || entry?.payload?.role !== 'user') return []
  if (!Array.isArray(entry?.payload?.content)) return []

  const prompts: string[] = []
  for (const item of entry.payload.content) {
    if (item?.type === 'input_text' && typeof item.text === 'string') {
      prompts.push(item.text)
    }
  }
  return prompts
}
