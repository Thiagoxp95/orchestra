// Reads the last assistant message from a Claude Code transcript JSONL file.
// Used after a Stop hook to classify whether Claude's final message is
// actually asking the user a question.
//
// Claude's JSONL format: one JSON object per line. Entries of type
// 'assistant' have `message.content` which is an array of blocks. Text
// blocks have `{ type: 'text', text: '...' }`. We collect all text blocks
// from the most recent assistant entry, joined by newlines.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'

/**
 * Claude Code stores transcripts under:
 *   ~/.claude/projects/<cwd-slug>/<session_id>.jsonl
 * The slug replaces every `/` in cwd with `-`. Paths starting with `/`
 * become slugs that start with `-`.
 * Example: `/Users/txp/Pessoal` → `-Users-txp-Pessoal`
 */
export function computeTranscriptPath(cwd: string, claudeSessionId: string): string | null {
  if (!cwd || !claudeSessionId) return null
  const slug = cwd.replace(/\//g, '-')
  return path.join(homedir(), '.claude', 'projects', slug, `${claudeSessionId}.jsonl`)
}

/**
 * Find the newest `.jsonl` file in the Claude project directory for `cwd`.
 * Used as a last resort when we don't have a claude session id either —
 * returns the most recently modified transcript in the directory.
 */
export function findLatestTranscriptForCwd(cwd: string): string | null {
  if (!cwd) return null
  const slug = cwd.replace(/\//g, '-')
  const dir = path.join(homedir(), '.claude', 'projects', slug)
  try {
    const entries = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => {
        const full = path.join(dir, name)
        try {
          const stat = fs.statSync(full)
          return { full, mtime: stat.mtimeMs }
        } catch {
          return null
        }
      })
      .filter((x): x is { full: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime)
    return entries[0]?.full ?? null
  } catch {
    return null
  }
}

interface AssistantContentBlock {
  type: string
  text?: string
}

interface AssistantMessage {
  role?: string
  content?: AssistantContentBlock[]
}

interface TranscriptEntry {
  type?: string
  message?: AssistantMessage
}

const MAX_LINES_TO_SCAN = 500

/**
 * Read the last assistant message's text content from a Claude transcript.
 * Returns null if the file is missing, malformed, or has no assistant entries.
 */
export function readLastAssistantMessage(transcriptPath: string): string | null {
  if (!transcriptPath) return null

  let content: string
  try {
    content = fs.readFileSync(transcriptPath, 'utf8')
  } catch {
    return null
  }

  const lines = content.split('\n').filter((line) => line.trim().length > 0)
  const start = Math.max(0, lines.length - MAX_LINES_TO_SCAN)

  // Walk backwards — the last assistant entry is what we want.
  for (let i = lines.length - 1; i >= start; i--) {
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue
    }

    if (entry.type !== 'assistant') continue
    const blocks = entry.message?.content
    if (!Array.isArray(blocks)) continue

    const textBlocks = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)

    if (textBlocks.length === 0) continue
    const joined = textBlocks.join('\n').trim()
    if (joined.length > 0) return joined
  }

  return null
}
