// codex-usage-probe.ts — Robust reader for Codex rate_limits from official JSONL sessions.
//
// Codex writes a `rate_limits` object into `event_msg` entries (type=token_count).
// The newest session does not always have one, so we fall through to the next
// newest file by mtime until either:
//   - we find a file with rate_limits, OR
//   - we've scanned `maxFiles` files, OR
//   - we've dropped past `maxAgeDays` old.
//
// If the matched event is older than `staleThresholdMs` we flag the result stale
// so the UI can dim the bars.

import { readdir, readFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { RateWindow } from '../shared/types'
import { formatResetText } from '../shared/usage-format'

export interface ScanOptions {
  baseDir?: string
  maxFiles?: number
  maxAgeDays?: number
  staleThresholdMs?: number
}

export type ScanResult =
  | { kind: 'no-sessions' }
  | { kind: 'no-recent-rate-limits' }
  | {
      kind: 'ok'
      session: RateWindow | null
      weekly: RateWindow | null
      stale: boolean
      ageMs: number
    }

const DEFAULT_BASE_DIR = join(homedir(), '.codex', 'sessions')
// Walk plenty of files: when a subscription hits its rate limit, every
// follow-up session writes a token_count with null primary/secondary until
// the limit resets, which can easily be dozens of files in a burst.
const DEFAULT_MAX_FILES = 50
const DEFAULT_MAX_AGE_DAYS = 7
const DEFAULT_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000

interface SessionFile {
  path: string
  mtimeMs: number
}

async function collectSessionFiles(baseDir: string, cutoffMs: number): Promise<SessionFile[]> {
  const out: SessionFile[] = []
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const s = await stat(full)
          if (s.mtimeMs >= cutoffMs) {
            out.push({ path: full, mtimeMs: s.mtimeMs })
          }
        } catch {
          // unreadable file — skip
        }
      }
    }
  }
  await walk(baseDir)
  return out
}

interface RateLimitsMatch {
  primary: unknown
  secondary: unknown
  timestampMs: number
}

function hasUsedPercent(obj: unknown): boolean {
  return !!obj && typeof obj === 'object' && typeof (obj as Record<string, unknown>).used_percent === 'number'
}

// Detects the "Plus user hit their 5h window and has no overage credits"
// signal Codex writes immediately after blocking a turn:
//   rate_limits: { limit_id: 'premium', primary: null, secondary: null,
//                  credits: { has_credits: false, ... } }
// When this appears *after* the last good subscription snapshot, the real
// state is "primary maxed, blocked until reset" — not the stale 61% we last
// saw. We surface that as 100%.
function isBlockedSignal(rateLimits: Record<string, unknown>): boolean {
  if (rateLimits.limit_id !== 'premium') return false
  const credits = rateLimits.credits as Record<string, unknown> | undefined
  return !!credits && credits.has_credits === false
}

interface ScanState {
  snapshot: RateLimitsMatch | null
  latestBlockedMs: number | null
}

function scanFileForRateLimits(content: string, state: ScanState): void {
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const entry = parsed as Record<string, unknown>
    if (entry.type !== 'event_msg') continue
    const payload = entry.payload as Record<string, unknown> | undefined
    if (!payload) continue
    const rateLimits = payload.rate_limits as Record<string, unknown> | undefined
    if (!rateLimits) continue

    const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    const timestampMs = Number.isFinite(ts) ? ts : Date.now()

    if (!state.snapshot && (hasUsedPercent(rateLimits.primary) || hasUsedPercent(rateLimits.secondary))) {
      state.snapshot = {
        primary: rateLimits.primary,
        secondary: rateLimits.secondary,
        timestampMs,
      }
    } else if (isBlockedSignal(rateLimits)) {
      if (state.latestBlockedMs === null || timestampMs > state.latestBlockedMs) {
        state.latestBlockedMs = timestampMs
      }
    }
    // Keep walking within the file so a blocked event newer than the
    // snapshot in the same file still registers.
  }
}

function toRateWindow(obj: unknown, overridePercent?: number): RateWindow | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const rawPct = typeof o.used_percent === 'number' ? o.used_percent : 0
  const pct = overridePercent ?? rawPct
  const resetsAt =
    typeof o.resets_at === 'number' ? new Date(o.resets_at * 1000).toISOString() : null
  return {
    usedPercent: Math.max(0, Math.min(100, pct)),
    resetsAt,
    resetText: formatResetText(resetsAt),
  }
}

export async function scanRecentCodexRateLimits(opts: ScanOptions = {}): Promise<ScanResult> {
  const baseDir = opts.baseDir ?? DEFAULT_BASE_DIR
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS
  const staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS

  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const files = await collectSessionFiles(baseDir, cutoffMs)
  if (files.length === 0) return { kind: 'no-sessions' }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const state: ScanState = { snapshot: null, latestBlockedMs: null }
  const budget = Math.min(files.length, maxFiles)
  for (let i = 0; i < budget; i++) {
    const file = files[i]
    let content: string
    try {
      content = await readFile(file.path, 'utf-8')
    } catch {
      continue
    }
    scanFileForRateLimits(content, state)
    if (state.snapshot) break
  }

  const match = state.snapshot
  if (match) {
    const primaryBlocked =
      state.latestBlockedMs !== null && state.latestBlockedMs > match.timestampMs
    const effectiveTimestampMs = primaryBlocked ? state.latestBlockedMs! : match.timestampMs
    const ageMs = Math.max(0, Date.now() - effectiveTimestampMs)
    return {
      kind: 'ok',
      session: toRateWindow(match.primary, primaryBlocked ? 100 : undefined),
      weekly: toRateWindow(match.secondary),
      stale: ageMs > staleThresholdMs,
      ageMs,
    }
  }

  return { kind: 'no-recent-rate-limits' }
}
