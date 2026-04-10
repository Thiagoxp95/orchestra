// usage-probe.ts — Parse CLI usage output from Claude /usage and Codex /status

import { readFile, readdir, stat, access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { RateWindow, UsageProbeResult } from '../shared/types'

// ---------------------------------------------------------------------------
// ANSI stripping
// ---------------------------------------------------------------------------

const ANSI_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[\x20-\x7e]|\r/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

// ---------------------------------------------------------------------------
// Internal parsed type (not exported)
// ---------------------------------------------------------------------------

interface ParsedProbe {
  session: RateWindow | null
  weekly: RateWindow | null
  error: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PCT_RE = /([0-9]{1,3}(?:\.[0-9]+)?)\s*%/
const RESET_RE = /resets?\s+(.*)/i

const REMAINING_KEYWORDS = ['remaining', 'left', 'available']
const USED_KEYWORDS = ['used', 'consumed', 'spent']

function isRemainingLine(line: string): boolean {
  const lower = line.toLowerCase()
  return REMAINING_KEYWORDS.some((k) => lower.includes(k))
}

function isUsedLine(line: string): boolean {
  const lower = line.toLowerCase()
  return USED_KEYWORDS.some((k) => lower.includes(k))
}

/** Extract percentage from a line, converting "remaining" to "used" if needed. */
function extractPercent(line: string): number | null {
  const m = line.match(PCT_RE)
  if (!m) return null
  const raw = parseFloat(m[1])
  if (isRemainingLine(line)) {
    return Math.max(0, Math.min(100, 100 - raw))
  }
  if (isUsedLine(line)) {
    return Math.max(0, Math.min(100, raw))
  }
  // Ambiguous — assume "used"
  return Math.max(0, Math.min(100, raw))
}

/** Scan forward from a percentage line for a nearby reset time. */
function findResetTime(lines: string[], fromIndex: number): string | null {
  // Look forward up to 3 lines, stop if we hit another percentage line
  const end = Math.min(lines.length, fromIndex + 4)
  for (let i = fromIndex + 1; i < end; i++) {
    // Stop at the next percentage line — it belongs to another section
    if (PCT_RE.test(lines[i])) break
    const m = lines[i].match(RESET_RE)
    if (m) return m[1].trim()
  }
  return null
}

// ---------------------------------------------------------------------------
// Claude /usage parser
// ---------------------------------------------------------------------------

const SESSION_LABELS = ['current session', 'session limit', 'session usage', 'session']
const WEEKLY_LABELS = ['current week', 'weekly limit', 'weekly usage', 'weekly', 'week']

function hasLabel(line: string, labels: string[]): boolean {
  const lower = line.toLowerCase()
  return labels.some((l) => lower.includes(l))
}

export function parseClaudeUsageOutput(raw: string): ParsedProbe {
  const clean = stripAnsi(raw)
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean)

  if (lines.length === 0) {
    return { session: null, weekly: null, error: null }
  }

  let session: RateWindow | null = null
  let weekly: RateWindow | null = null

  // Label-based extraction
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const pct = extractPercent(line)
    if (pct === null) continue

    if (!session && hasLabel(line, SESSION_LABELS)) {
      session = { usedPercent: pct, resetsAt: findResetTime(lines, i) }
    } else if (!weekly && hasLabel(line, WEEKLY_LABELS)) {
      weekly = { usedPercent: pct, resetsAt: findResetTime(lines, i) }
    }
  }

  // Fallback: positional extraction if no labels found
  if (!session && !weekly) {
    const pctLines: { index: number; pct: number }[] = []
    for (let i = 0; i < lines.length; i++) {
      const pct = extractPercent(lines[i])
      if (pct !== null) pctLines.push({ index: i, pct })
    }

    if (pctLines.length >= 1) {
      session = { usedPercent: pctLines[0].pct, resetsAt: findResetTime(lines, pctLines[0].index) }
    }
    if (pctLines.length >= 2) {
      weekly = { usedPercent: pctLines[1].pct, resetsAt: findResetTime(lines, pctLines[1].index) }
    }

    // If we found nothing at all, report an error
    if (pctLines.length === 0) {
      return { session: null, weekly: null, error: 'Could not parse usage output' }
    }
  }

  return { session, weekly, error: null }
}

// ---------------------------------------------------------------------------
// Codex /status parser
// ---------------------------------------------------------------------------

const CODEX_5H_LABELS = ['5h', '5 hour', '5-hour', '5hr', 'short', 'session']
const CODEX_WEEKLY_LABELS = ['weekly', 'week', '7d', '7 day']

export function parseCodexStatusOutput(raw: string): ParsedProbe {
  const clean = stripAnsi(raw)
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean)

  if (lines.length === 0) {
    return { session: null, weekly: null, error: null }
  }

  let session: RateWindow | null = null
  let weekly: RateWindow | null = null

  // Label-based extraction
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const pct = extractPercent(line)
    if (pct === null) continue

    if (!session && hasLabel(line, CODEX_5H_LABELS)) {
      session = { usedPercent: pct, resetsAt: findResetTime(lines, i) }
    } else if (!weekly && hasLabel(line, CODEX_WEEKLY_LABELS)) {
      weekly = { usedPercent: pct, resetsAt: findResetTime(lines, i) }
    }
  }

  // Fallback: positional extraction
  if (!session && !weekly) {
    const pctLines: { index: number; pct: number }[] = []
    for (let i = 0; i < lines.length; i++) {
      const pct = extractPercent(lines[i])
      if (pct !== null) pctLines.push({ index: i, pct })
    }

    if (pctLines.length >= 1) {
      session = { usedPercent: pctLines[0].pct, resetsAt: findResetTime(lines, pctLines[0].index) }
    }
    if (pctLines.length >= 2) {
      weekly = { usedPercent: pctLines[1].pct, resetsAt: findResetTime(lines, pctLines[1].index) }
    }

    if (pctLines.length === 0) {
      return { session: null, weekly: null, error: 'Could not parse status output' }
    }
  }

  return { session, weekly, error: null }
}

// ---------------------------------------------------------------------------
// ccline invocation — refresh cache by invoking the ccline binary with stdin
// ---------------------------------------------------------------------------

const CCLINE_BIN = join(homedir(), '.claude', 'ccline', 'ccline')
const CCLINE_TIMEOUT_MS = 8_000

/** Minimal JSON input that ccline expects on stdin to render its status line + refresh cache. */
const CCLINE_STDIN_PAYLOAD = JSON.stringify({
  model: { name: 'claude-opus-4-6', id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
  session_id: 'orchestra-probe',
  cwd: homedir(),
  git_branch: '',
  workspace: { name: 'probe', root: homedir(), current_dir: homedir() },
  context_window: { used: 0, total: 200000 },
  cost: { session: 0 },
  session: { duration_seconds: 0 },
  output_style: { name: 'standard' },
  transcript_path: '/dev/null',
})

async function cclineExists(): Promise<boolean> {
  try {
    await access(CCLINE_BIN)
    return true
  } catch {
    return false
  }
}

function invokeCcline(): Promise<void> {
  return new Promise((resolve) => {
    const child = execFile(CCLINE_BIN, [], { timeout: CCLINE_TIMEOUT_MS }, () => resolve())
    child.stdin?.write(CCLINE_STDIN_PAYLOAD)
    child.stdin?.end()
  })
}

// ---------------------------------------------------------------------------
// Public probe functions
// ---------------------------------------------------------------------------

const STALE_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Estimate when Claude's 5-hour rolling session window resets by scanning recent
 * project JSONL files for the oldest message timestamp within the last 5 hours.
 * Returns the estimated reset (oldest_in_window + 5h) as an ISO string, or null
 * if there's no recent activity.
 *
 * This is an estimate: ccline's cache only exposes the weekly reset, and calling
 * Anthropic's /api/oauth/usage directly would require OAuth refresh handling.
 */
async function estimateClaudeSessionReset(): Promise<string | null> {
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
  const cutoffMs = Date.now() - FIVE_HOURS_MS
  const baseDir = join(homedir(), '.claude', 'projects')

  let oldestInWindowMs: number | null = null

  try {
    const entries = await readdir(baseDir, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const fullPath = join((entry as any).parentPath ?? (entry as any).path ?? baseDir, entry.name)
      try {
        const s = await stat(fullPath)
        // Files not touched in the last 5h can't contain in-window timestamps
        if (s.mtimeMs < cutoffMs) continue

        const content = await readFile(fullPath, 'utf-8')
        for (const line of content.split('\n')) {
          const m = line.match(/"timestamp":"([^"]+)"/)
          if (!m) continue
          const ts = Date.parse(m[1])
          if (isNaN(ts) || ts < cutoffMs) continue
          // First in-window timestamp encountered is the oldest in this file
          if (oldestInWindowMs === null || ts < oldestInWindowMs) {
            oldestInWindowMs = ts
          }
          break
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* projects dir missing — no estimate */ }

  if (oldestInWindowMs === null) return null
  return new Date(oldestInWindowMs + FIVE_HOURS_MS).toISOString()
}

export async function probeClaudeUsage(): Promise<UsageProbeResult> {
  const cachePath = join(homedir(), '.claude', 'ccline', '.api_usage_cache.json')

  // Helper: read and parse the cache file
  const readCache = async () => {
    const raw = await readFile(cachePath, 'utf-8')
    return JSON.parse(raw) as {
      five_hour_utilization?: number
      seven_day_utilization?: number
      resets_at?: string
      cached_at?: string
    }
  }

  // Helper: convert cache data to probe result
  const toResult = async (data: Awaited<ReturnType<typeof readCache>>, stale: boolean): Promise<UsageProbeResult> => {
    const sessionReset = data.five_hour_utilization != null ? await estimateClaudeSessionReset() : null
    const session: RateWindow | null =
      data.five_hour_utilization != null
        ? { usedPercent: data.five_hour_utilization, resetsAt: sessionReset }
        : null
    const weekly: RateWindow | null =
      data.seven_day_utilization != null
        ? { usedPercent: data.seven_day_utilization, resetsAt: data.resets_at ?? null }
        : null

    if (!session && !weekly) {
      return { provider: 'claude', session: null, weekly: null, error: 'No utilization data in cache', updatedAt: Date.now() }
    }
    return { provider: 'claude', session, weekly, error: stale ? 'stale' : null, updatedAt: Date.now() }
  }

  try {
    let data = await readCache()
    const cachedAt = data.cached_at ? new Date(data.cached_at).getTime() : 0
    const isStale = Date.now() - cachedAt > STALE_THRESHOLD_MS

    // If stale, invoke ccline to refresh the cache, then re-read
    if (isStale && await cclineExists()) {
      await invokeCcline()
      try {
        data = await readCache()
        const nowFresh = data.cached_at ? (Date.now() - new Date(data.cached_at).getTime() < STALE_THRESHOLD_MS) : false
        return await toResult(data, !nowFresh)
      } catch {
        // ccline failed to refresh, return stale data
        return await toResult(data, true)
      }
    }

    return await toResult(data, isStale)
  } catch {
    // No cache file at all — try invoking ccline to create one
    if (await cclineExists()) {
      await invokeCcline()
      try {
        const data = await readCache()
        return await toResult(data, false)
      } catch { /* fall through */ }
    }
    return { provider: 'claude', session: null, weekly: null, error: 'Could not read usage cache', updatedAt: Date.now() }
  }
}

export async function probeCodexUsage(): Promise<UsageProbeResult> {
  // Read rate-limit data from the most recent Codex JSONL session file
  // (Codex stores rate_limits in event_msg entries with type=token_count)
  const baseDir = join(homedir(), '.codex', 'sessions')
  try {
    // Find the most recently modified .jsonl file
    const allEntries = await readdir(baseDir, { withFileTypes: true, recursive: true }).catch(() => [])
    let newestPath: string | null = null
    let newestMtime = 0

    for (const entry of allEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const fullPath = join((entry as any).parentPath ?? (entry as any).path ?? baseDir, entry.name)
      try {
        const s = await stat(fullPath)
        if (s.mtimeMs > newestMtime) {
          newestMtime = s.mtimeMs
          newestPath = fullPath
        }
      } catch { /* skip */ }
    }

    if (!newestPath) {
      return { provider: 'codex', session: null, weekly: null, error: 'No Codex sessions found', updatedAt: Date.now() }
    }

    // Read the file and find the last rate_limits entry
    const content = await readFile(newestPath, 'utf-8')
    const lines = content.split('\n')

    let rateLimits: any = null
    // Scan from the end for the last rate_limits entry
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const entry = JSON.parse(line)
        if (entry?.type === 'event_msg' && entry?.payload?.rate_limits) {
          rateLimits = entry.payload.rate_limits
          break
        }
      } catch { /* skip malformed lines */ }
    }

    if (!rateLimits) {
      return { provider: 'codex', session: null, weekly: null, error: 'No rate limit data in sessions', updatedAt: Date.now() }
    }

    const primary = rateLimits.primary
    const secondary = rateLimits.secondary

    const session: RateWindow | null = primary
      ? {
          usedPercent: primary.used_percent ?? 0,
          resetsAt: primary.resets_at
            ? new Date(primary.resets_at * 1000).toISOString()
            : null,
        }
      : null

    const weekly: RateWindow | null = secondary
      ? {
          usedPercent: secondary.used_percent ?? 0,
          resetsAt: secondary.resets_at
            ? new Date(secondary.resets_at * 1000).toISOString()
            : null,
        }
      : null

    return { provider: 'codex', session, weekly, error: null, updatedAt: Date.now() }
  } catch {
    return { provider: 'codex', session: null, weekly: null, error: 'Could not read Codex sessions', updatedAt: Date.now() }
  }
}
