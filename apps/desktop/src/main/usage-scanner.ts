// src/main/usage-scanner.ts
//
// Scans Claude and Codex JSONL session logs to aggregate token usage,
// cost estimates, and daily/model breakdowns.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DailyTokenEntry, ModelTokenSummary, UsageScanResult } from '../shared/types'

// ─── Internal types ─────────────────────────────────────────────────────────

interface TokenEntry {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  timestamp: string
}

// ─── Pricing constants (as of March 2026 — update when Anthropic changes pricing) ──

interface PricingTier {
  input: number   // $/M tokens
  output: number  // $/M tokens
  cacheRead: number
  cacheWrite: number
}

const PRICING: Record<string, PricingTier> = {
  'claude-opus': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  default: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function getPricing(model: string): PricingTier {
  const lower = model.toLowerCase()
  if (lower.includes('opus')) return PRICING['claude-opus']
  if (lower.includes('haiku')) return PRICING['claude-haiku']
  if (lower.includes('sonnet')) return PRICING['claude-sonnet']
  return PRICING['default']
}

function aggregateModelSummary(entries: TokenEntry[]): ModelTokenSummary[] {
  const map = new Map<string, ModelTokenSummary>()
  for (const e of entries) {
    let s = map.get(e.model)
    if (!s) {
      s = {
        model: e.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        messageCount: 0,
      }
      map.set(e.model, s)
    }
    s.inputTokens += e.inputTokens
    s.outputTokens += e.outputTokens
    s.cacheReadTokens += e.cacheReadTokens
    s.cacheWriteTokens += e.cacheWriteTokens
    s.messageCount += 1
  }
  return Array.from(map.values())
}

async function scanJsonlFiles(dir: string, maxAgeDays: number): Promise<string[]> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const results: string[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const fullPath = join((entry as any).parentPath ?? (entry as any).path ?? dir, entry.name)
      try {
        const s = await stat(fullPath)
        if (s.mtimeMs >= cutoff) {
          results.push(fullPath)
        }
      } catch {
        // skip inaccessible files
      }
    }
  } catch {
    // directory doesn't exist — that's fine
  }
  return results
}

async function scanCodexSessionDirs(baseDir: string, maxAgeDays: number): Promise<string[]> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const results: string[] = []
  try {
    const entries = await readdir(baseDir, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const fullPath = join((entry as any).parentPath ?? (entry as any).path ?? baseDir, entry.name)
      try {
        const s = await stat(fullPath)
        if (s.mtimeMs >= cutoff) {
          results.push(fullPath)
        }
      } catch {
        // skip inaccessible files
      }
    }
  } catch {
    // directory doesn't exist — that's fine
  }
  return results
}

async function parseJsonlEntries(
  filePath: string,
  extractor: (entry: any) => TokenEntry | null,
): Promise<TokenEntry[]> {
  const results: TokenEntry[] = []
  try {
    const content = await readFile(filePath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        const entry = extractor(parsed)
        if (entry) results.push(entry)
      } catch {
        // malformed line — skip
      }
    }
  } catch {
    // unreadable file — skip
  }
  return results
}

function buildScanResult(
  provider: 'claude' | 'codex',
  entries: TokenEntry[],
): UsageScanResult {
  const today = new Date().toISOString().slice(0, 10)
  const todayEntries = entries.filter((e) => e.timestamp.slice(0, 10) === today)

  let todayTokensIn = 0
  let todayTokensOut = 0
  let todayCostEstimate = 0
  for (const e of todayEntries) {
    todayTokensIn += e.inputTokens
    todayTokensOut += e.outputTokens
    todayCostEstimate += estimateCostUSD(
      e.model,
      e.inputTokens,
      e.outputTokens,
      e.cacheReadTokens,
      e.cacheWriteTokens,
    )
  }

  return {
    provider,
    todayMessages: todayEntries.length,
    todayTokensIn,
    todayTokensOut,
    todayCostEstimate: Math.round(todayCostEstimate * 100) / 100,
    last30Days: aggregateDailyTokens(entries),
    modelBreakdown: aggregateModelSummary(entries),
    updatedAt: Date.now(),
  }
}

// ─── Exported functions ─────────────────────────────────────────────────────

export function extractClaudeTokenUsage(entry: any): TokenEntry | null {
  if (entry?.type !== 'assistant') return null
  const msg = entry.message
  if (!msg?.usage || !msg?.model) return null
  const u = msg.usage
  return {
    model: msg.model,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    timestamp: entry.timestamp ?? '',
  }
}

export function extractCodexTokenUsage(entry: any): TokenEntry | null {
  if (entry?.type !== 'event_msg') return null
  const usage = entry?.payload?.info?.total_token_usage
  if (!usage) return null
  return {
    model: entry.payload?.info?.model ?? 'codex',
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cached_input_tokens ?? 0,
    cacheWriteTokens: usage.reasoning_output_tokens ?? 0,
    timestamp: entry.timestamp ?? entry.payload?.timestamp ?? '',
  }
}

export function estimateCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
): number {
  const p = getPricing(model)
  return (
    (inputTokens / 1_000_000) * p.input +
    (outputTokens / 1_000_000) * p.output +
    (cacheReadTokens / 1_000_000) * p.cacheRead +
    (cacheWriteTokens / 1_000_000) * p.cacheWrite
  )
}

export function aggregateDailyTokens(entries: TokenEntry[]): DailyTokenEntry[] {
  const map = new Map<string, DailyTokenEntry>()
  for (const e of entries) {
    const date = e.timestamp.slice(0, 10)
    if (!date) continue
    let d = map.get(date)
    if (!d) {
      d = { date, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      map.set(date, d)
    }
    d.inputTokens += e.inputTokens
    d.outputTokens += e.outputTokens
    d.cacheReadTokens += e.cacheReadTokens
    d.cacheWriteTokens += e.cacheWriteTokens
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date))
}

export async function scanClaudeUsage(): Promise<UsageScanResult> {
  const baseDir = join(homedir(), '.claude', 'projects')
  const files = await scanJsonlFiles(baseDir, 30)
  const allEntries: TokenEntry[] = []
  for (const f of files) {
    const entries = await parseJsonlEntries(f, extractClaudeTokenUsage)
    allEntries.push(...entries)
  }
  return buildScanResult('claude', allEntries)
}

export async function scanCodexUsage(): Promise<UsageScanResult> {
  const baseDir = join(homedir(), '.codex', 'sessions')
  const files = await scanCodexSessionDirs(baseDir, 30)
  const allEntries: TokenEntry[] = []
  for (const f of files) {
    const entries = await parseJsonlEntries(f, extractCodexTokenUsage)
    allEntries.push(...entries)
  }
  return buildScanResult('codex', allEntries)
}
