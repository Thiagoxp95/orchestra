# Usage Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact usage badge in the footer showing session and weekly rate-limit percentages for Claude and Codex, with a full stats panel on click.

**Architecture:** Main process spawns background PTYs to run `claude` and `codex` CLI tools, sends `/usage` (Claude) or `/status` (Codex), parses ANSI-stripped output for rate-limit percentages and reset times. A JSONL scanner reads `~/.claude/projects/` and `~/.codex/sessions/` for token/cost aggregates. Data flows via IPC to renderer, displayed as a compact NavBar badge and a slide-in UsagePanel.

**Tech Stack:** Electron (node-pty for background PTYs), TypeScript, React, zustand, Tailwind CSS

---

## File Structure

### Main Process (new files)
- `src/main/usage-probe.ts` — Spawns background PTYs, runs `/usage` and `/status`, parses output into `UsageProbeResult`
- `src/main/usage-probe.test.ts` — Tests for ANSI stripping and percentage parsing
- `src/main/usage-scanner.ts` — Reads JSONL files from `~/.claude/` and `~/.codex/` for token aggregates, daily stats, cost estimates
- `src/main/usage-scanner.test.ts` — Tests for JSONL parsing and aggregation
- `src/main/usage-manager.ts` — Orchestrates probe + scanner, polls on interval, emits IPC events to renderer

### Shared Types (modify)
- `src/shared/types.ts` — Add `UsageSnapshot`, `UsageProbeResult`, `UsageScanResult`, `ElectronAPI` additions

### Preload (modify)
- `src/preload/index.ts` — Wire new IPC channels

### Renderer (new + modify)
- `src/renderer/src/components/UsageBadge.tsx` — Compact two-percentage badge for NavBar
- `src/renderer/src/components/UsagePanel.tsx` — Full stats panel (slide-in from right, like DiffPanel)
- `src/renderer/src/components/UsageBar.tsx` — Reusable progress bar with color thresholds
- `src/renderer/src/components/NavBar.tsx` — Add UsageBadge to right-aligned section
- `src/renderer/src/App.tsx` — Add UsagePanel toggle state and render slot
- `src/renderer/src/store/app-store.ts` — Add usage state and panel toggle

---

### Task 1: Shared Types

**Files:**
- Modify: `apps/desktop/src/shared/types.ts`

- [ ] **Step 1: Add usage types to shared/types.ts**

Add after the `UpdateStatus` interface (around line 354):

```typescript
// Usage tracking
export interface RateWindow {
  usedPercent: number    // 0-100
  resetsAt: string | null // ISO date or human-readable
}

export interface UsageProbeResult {
  provider: 'claude' | 'codex'
  session: RateWindow | null
  weekly: RateWindow | null
  error: string | null
  updatedAt: number
}

export interface DailyTokenEntry {
  date: string // YYYY-MM-DD
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ModelTokenSummary {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  messageCount: number
}

export interface UsageScanResult {
  provider: 'claude' | 'codex'
  todayMessages: number
  todayTokensIn: number
  todayTokensOut: number
  todayCostEstimate: number // USD
  last30Days: DailyTokenEntry[]
  modelBreakdown: ModelTokenSummary[]
  updatedAt: number
}

export interface UsageSnapshot {
  claude: { probe: UsageProbeResult | null; scan: UsageScanResult | null }
  codex: { probe: UsageProbeResult | null; scan: UsageScanResult | null }
}
```

- [ ] **Step 2: Add ElectronAPI methods**

Add to the `ElectronAPI` interface, after the auto-update section (around line 313):

```typescript
  // Usage tracking
  getUsageSnapshot: () => Promise<UsageSnapshot>
  onUsageUpdate: (callback: (snapshot: UsageSnapshot) => void) => () => void
  refreshUsage: () => Promise<void>
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/shared/types.ts
git commit -m "feat(usage): add shared types for usage tracking"
```

---

### Task 2: Usage Probe — Output Parser

**Files:**
- Create: `apps/desktop/src/main/usage-probe.ts`
- Create: `apps/desktop/src/main/usage-probe.test.ts`

- [ ] **Step 1: Write tests for ANSI stripping and Claude output parsing**

Create `apps/desktop/src/main/usage-probe.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { stripAnsi, parseClaudeUsageOutput, parseCodexStatusOutput } from './usage-probe'

describe('stripAnsi', () => {
  it('removes ANSI escape codes', () => {
    expect(stripAnsi('\x1b[32mhello\x1b[0m')).toBe('hello')
  })

  it('passes through plain text', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
  })
})

describe('parseClaudeUsageOutput', () => {
  it('extracts session and weekly percentages from "remaining" output', () => {
    const output = [
      'Settings: Model: claude-opus-4-6 | Usage:',
      '  Current session: 42.3% remaining',
      '  Resets in 3h 12m',
      '  Current week: 81.9% remaining',
      '  Resets in 4d 2h',
    ].join('\n')
    const result = parseClaudeUsageOutput(output)
    expect(result.session).toEqual({ usedPercent: 57.7, resetsAt: 'in 3h 12m' })
    expect(result.weekly).toEqual({ usedPercent: 18.1, resetsAt: 'in 4d 2h' })
    expect(result.error).toBeNull()
  })

  it('extracts percentages from "used" output', () => {
    const output = [
      'Settings: Model: claude-opus-4-6 | Usage:',
      '  Current session: 25.0% used',
      '  Current week: 10.5% used',
    ].join('\n')
    const result = parseClaudeUsageOutput(output)
    expect(result.session?.usedPercent).toBe(25.0)
    expect(result.weekly?.usedPercent).toBe(10.5)
  })

  it('handles missing weekly window', () => {
    const output = [
      'Current session: 15.0% remaining',
    ].join('\n')
    const result = parseClaudeUsageOutput(output)
    expect(result.session?.usedPercent).toBe(85.0)
    expect(result.weekly).toBeNull()
  })

  it('returns error for unparseable output', () => {
    const result = parseClaudeUsageOutput('some random text')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.error).toBeTruthy()
  })
})

describe('parseCodexStatusOutput', () => {
  it('extracts 5h and weekly limits', () => {
    const output = [
      '5h limit: 80% remaining, resets at 14:30',
      'Weekly limit: 60% remaining, resets at 18:00 on Mar 28',
    ].join('\n')
    const result = parseCodexStatusOutput(output)
    expect(result.session?.usedPercent).toBe(20)
    expect(result.weekly?.usedPercent).toBe(40)
  })

  it('returns nulls for empty output', () => {
    const result = parseCodexStatusOutput('')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd apps/desktop && npx vitest run src/main/usage-probe.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the parser**

Create `apps/desktop/src/main/usage-probe.ts`:

```typescript
import type { RateWindow, UsageProbeResult } from '../shared/types'

// --- ANSI stripping ---

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b\[[\?]?[0-9;]*[hlm]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

// --- Percentage extraction ---

const PERCENT_RE = /([0-9]{1,3}(?:\.[0-9]+)?)\s*%/

const USED_KEYWORDS = ['used', 'spent', 'consumed']
const REMAINING_KEYWORDS = ['left', 'remaining', 'available']

function extractPercent(line: string): { usedPercent: number } | null {
  const match = line.match(PERCENT_RE)
  if (!match) return null
  const raw = parseFloat(match[1])
  if (!Number.isFinite(raw)) return null

  const lower = line.toLowerCase()
  const isUsed = USED_KEYWORDS.some((kw) => lower.includes(kw))
  const isRemaining = REMAINING_KEYWORDS.some((kw) => lower.includes(kw))

  let usedPercent: number
  if (isUsed) {
    usedPercent = raw
  } else if (isRemaining) {
    usedPercent = Math.max(0, Math.min(100, 100 - raw))
  } else {
    // Default: treat as remaining (codexbar convention)
    usedPercent = Math.max(0, Math.min(100, 100 - raw))
  }

  return { usedPercent: Math.round(usedPercent * 10) / 10 }
}

const RESETS_RE = /resets?\s+(.*)/i

function extractResetTime(lines: string[], startIndex: number): string | null {
  // Check the same line and up to 2 lines after for reset info
  for (let i = startIndex; i < Math.min(startIndex + 3, lines.length); i++) {
    const match = lines[i].match(RESETS_RE)
    if (match) return match[1].trim()
  }
  return null
}

// --- Claude /usage output parsing ---

interface ParsedProbe {
  session: RateWindow | null
  weekly: RateWindow | null
  error: string | null
}

export function parseClaudeUsageOutput(raw: string): ParsedProbe {
  const text = stripAnsi(raw)
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)

  let session: RateWindow | null = null
  let weekly: RateWindow | null = null

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase()

    if (lower.includes('current session') || lower.includes('session limit')) {
      const pct = extractPercent(lines[i])
      if (pct) {
        session = { usedPercent: pct.usedPercent, resetsAt: extractResetTime(lines, i + 1) }
      }
      continue
    }

    if (
      lower.includes('current week')
      || lower.includes('weekly limit')
      || lower.includes('week (')
    ) {
      const pct = extractPercent(lines[i])
      if (pct) {
        weekly = { usedPercent: pct.usedPercent, resetsAt: extractResetTime(lines, i + 1) }
      }
      continue
    }
  }

  // Fallback: if no labeled lines found, try positional extraction
  if (!session && !weekly) {
    const percentLines = lines.filter((l) => PERCENT_RE.test(l))
    if (percentLines.length >= 1) {
      const pct = extractPercent(percentLines[0])
      if (pct) session = { usedPercent: pct.usedPercent, resetsAt: null }
    }
    if (percentLines.length >= 2) {
      const pct = extractPercent(percentLines[1])
      if (pct) weekly = { usedPercent: pct.usedPercent, resetsAt: null }
    }
  }

  return {
    session,
    weekly,
    error: (!session && !weekly) ? 'Could not parse usage output' : null,
  }
}

// --- Codex /status output parsing ---

export function parseCodexStatusOutput(raw: string): ParsedProbe {
  const text = stripAnsi(raw)
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)

  let session: RateWindow | null = null
  let weekly: RateWindow | null = null

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase()

    if (lower.includes('5h limit') || lower.includes('5-hour') || lower.includes('session')) {
      const pct = extractPercent(lines[i])
      if (pct) {
        session = { usedPercent: pct.usedPercent, resetsAt: extractResetTime(lines, i) }
      }
      continue
    }

    if (lower.includes('weekly limit') || lower.includes('weekly')) {
      const pct = extractPercent(lines[i])
      if (pct) {
        weekly = { usedPercent: pct.usedPercent, resetsAt: extractResetTime(lines, i) }
      }
      continue
    }
  }

  return {
    session,
    weekly,
    error: (!session && !weekly) ? 'Could not parse status output' : null,
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd apps/desktop && npx vitest run src/main/usage-probe.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/usage-probe.ts apps/desktop/src/main/usage-probe.test.ts
git commit -m "feat(usage): add CLI output parser for Claude /usage and Codex /status"
```

---

### Task 3: Usage Probe — PTY Runner

**Files:**
- Modify: `apps/desktop/src/main/usage-probe.ts`

This adds the actual PTY spawning logic that runs the CLI tools in the background.
Note: `node-pty` is already a project dependency and is externalized by `externalizeDepsPlugin()` in
`electron.vite.config.ts` (preload config), so direct imports in the main process work fine.

- [ ] **Step 1: Add PTY imports and probe runner to usage-probe.ts**

Add these imports **at the top** of `apps/desktop/src/main/usage-probe.ts`, alongside the existing type import:

```typescript
import * as pty from 'node-pty'
import { execSync } from 'node:child_process'
```

Then add the following functions **at the bottom** of the file:

```typescript
const PROBE_TIMEOUT_MS = 15_000
const PROBE_COLS = 200
const PROBE_ROWS = 60

function resolveBinary(name: string): string | null {
  try {
    return execSync(`which ${name}`, { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

export async function probeClaudeUsage(): Promise<UsageProbeResult> {
  const binary = resolveBinary('claude')
  if (!binary) {
    return { provider: 'claude', session: null, weekly: null, error: 'claude not installed', updatedAt: Date.now() }
  }

  try {
    const output = await runPtyCommand(binary, [], '/usage\n', PROBE_TIMEOUT_MS)
    const parsed = parseClaudeUsageOutput(output)
    return {
      provider: 'claude',
      session: parsed.session,
      weekly: parsed.weekly,
      error: parsed.error,
      updatedAt: Date.now(),
    }
  } catch (err: any) {
    return { provider: 'claude', session: null, weekly: null, error: err.message ?? 'probe failed', updatedAt: Date.now() }
  }
}

export async function probeCodexUsage(): Promise<UsageProbeResult> {
  const binary = resolveBinary('codex')
  if (!binary) {
    return { provider: 'codex', session: null, weekly: null, error: 'codex not installed', updatedAt: Date.now() }
  }

  try {
    const output = await runPtyCommand(binary, [], '/status\n', PROBE_TIMEOUT_MS)
    const parsed = parseCodexStatusOutput(output)
    return {
      provider: 'codex',
      session: parsed.session,
      weekly: parsed.weekly,
      error: parsed.error,
      updatedAt: Date.now(),
    }
  } catch (err: any) {
    return { provider: 'codex', session: null, weekly: null, error: err.message ?? 'probe failed', updatedAt: Date.now() }
  }
}

function runPtyCommand(binary: string, args: string[], command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = []
    let settled = false
    let commandSent = false

    const proc = pty.spawn(binary, args, {
      name: 'xterm-256color',
      cols: PROBE_COLS,
      rows: PROBE_ROWS,
      cwd: process.env.HOME ?? '/tmp',
      env: { ...process.env, TERM: 'xterm-256color' },
    })

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      try { proc.kill() } catch {}
      resolve(chunks.join(''))
    }, timeoutMs)

    proc.onData((data) => {
      chunks.push(data)

      // Only look for result data AFTER we've sent the command
      if (!commandSent) return

      const fullOutput = chunks.join('')
      const stripped = stripAnsi(fullOutput)
      const hasPercent = (stripped.match(/%/g) ?? []).length >= 1
      const hasResets = /resets?\s/i.test(stripped)

      if (hasPercent && hasResets) {
        // Give a small buffer to collect remaining output
        setTimeout(() => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          try { proc.kill() } catch {}
          resolve(chunks.join(''))
        }, 500)
      }
    })

    proc.onExit(() => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(chunks.join(''))
    })

    // Wait for CLI to initialize, then send command
    // Claude/Codex CLI needs time to start up (MCP servers, hooks, etc.)
    setTimeout(() => {
      if (!settled) {
        commandSent = true
        try { proc.write(command) } catch {}
      }
    }, 2000)
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/main/usage-probe.ts
git commit -m "feat(usage): add PTY runner for background Claude/Codex probes"
```

---

### Task 4: JSONL Scanner

**Files:**
- Create: `apps/desktop/src/main/usage-scanner.ts`
- Create: `apps/desktop/src/main/usage-scanner.test.ts`

- [ ] **Step 1: Write tests for JSONL token extraction**

Create `apps/desktop/src/main/usage-scanner.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { extractClaudeTokenUsage, estimateCostUSD, aggregateDailyTokens } from './usage-scanner'

describe('extractClaudeTokenUsage', () => {
  it('extracts token counts from assistant entry', () => {
    const entry = {
      type: 'assistant',
      timestamp: '2026-03-23T10:00:00.000Z',
      message: {
        model: 'claude-opus-4-6',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
        },
      },
    }
    const result = extractClaudeTokenUsage(entry)
    expect(result).toEqual({
      model: 'claude-opus-4-6',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 300,
      cacheWriteTokens: 200,
      timestamp: '2026-03-23T10:00:00.000Z',
    })
  })

  it('returns null for non-assistant entries', () => {
    expect(extractClaudeTokenUsage({ type: 'user' })).toBeNull()
  })
})

describe('estimateCostUSD', () => {
  it('estimates cost for opus model', () => {
    const cost = estimateCostUSD('claude-opus-4-6', 1_000_000, 500_000, 0, 0)
    // opus: $15/M input, $75/M output
    expect(cost).toBeCloseTo(15 + 37.5, 1)
  })

  it('estimates cost for sonnet model', () => {
    const cost = estimateCostUSD('claude-sonnet-4-6', 1_000_000, 500_000, 0, 0)
    // sonnet: $3/M input, $15/M output
    expect(cost).toBeCloseTo(3 + 7.5, 1)
  })
})

describe('aggregateDailyTokens', () => {
  it('groups entries by date', () => {
    const entries = [
      { model: 'm', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, timestamp: '2026-03-23T10:00:00Z' },
      { model: 'm', inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, timestamp: '2026-03-23T14:00:00Z' },
      { model: 'm', inputTokens: 300, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0, timestamp: '2026-03-22T10:00:00Z' },
    ]
    const daily = aggregateDailyTokens(entries)
    expect(daily).toHaveLength(2)
    const march23 = daily.find((d) => d.date === '2026-03-23')
    expect(march23?.inputTokens).toBe(300)
    expect(march23?.outputTokens).toBe(150)
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd apps/desktop && npx vitest run src/main/usage-scanner.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the scanner**

Create `apps/desktop/src/main/usage-scanner.ts`:

```typescript
import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import type { UsageScanResult, DailyTokenEntry, ModelTokenSummary } from '../shared/types'

// --- Token pricing (USD per million tokens, as of March 2026) ---
// These are estimates — update when Anthropic changes pricing

const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'default': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
}

function getPricing(model: string) {
  const lower = model.toLowerCase()
  if (lower.includes('opus')) return PRICING['claude-opus']
  if (lower.includes('haiku')) return PRICING['claude-haiku']
  if (lower.includes('sonnet')) return PRICING['claude-sonnet']
  return PRICING['default']
}

export function estimateCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  const p = getPricing(model)
  return (
    (inputTokens / 1_000_000) * p.input
    + (outputTokens / 1_000_000) * p.output
    + (cacheReadTokens / 1_000_000) * p.cacheRead
    + (cacheWriteTokens / 1_000_000) * p.cacheWrite
  )
}

// --- JSONL parsing ---

interface TokenEntry {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  timestamp: string
}

export function extractClaudeTokenUsage(entry: any): TokenEntry | null {
  if (entry?.type !== 'assistant') return null
  const msg = entry?.message
  if (!msg?.usage) return null

  return {
    model: msg.model ?? 'unknown',
    inputTokens: msg.usage.input_tokens ?? 0,
    outputTokens: msg.usage.output_tokens ?? 0,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
    timestamp: entry.timestamp ?? '',
  }
}

export function extractCodexTokenUsage(entry: any): TokenEntry | null {
  if (entry?.type !== 'event_msg') return null
  const info = entry?.payload?.info
  if (!info?.total_token_usage) return null

  const usage = info.total_token_usage
  return {
    model: info.model ?? 'codex',
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cached_input_tokens ?? 0,
    cacheWriteTokens: 0,
    timestamp: entry.timestamp ?? entry.payload?.timestamp ?? '',
  }
}

export function aggregateDailyTokens(entries: TokenEntry[]): DailyTokenEntry[] {
  const byDate = new Map<string, DailyTokenEntry>()

  for (const e of entries) {
    const date = e.timestamp.slice(0, 10) // YYYY-MM-DD
    if (!date || date.length !== 10) continue

    const existing = byDate.get(date)
    if (existing) {
      existing.inputTokens += e.inputTokens
      existing.outputTokens += e.outputTokens
      existing.cacheReadTokens += e.cacheReadTokens
      existing.cacheWriteTokens += e.cacheWriteTokens
    } else {
      byDate.set(date, {
        date,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cacheReadTokens: e.cacheReadTokens,
        cacheWriteTokens: e.cacheWriteTokens,
      })
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function aggregateModelSummary(entries: TokenEntry[]): ModelTokenSummary[] {
  const byModel = new Map<string, ModelTokenSummary>()

  for (const e of entries) {
    const existing = byModel.get(e.model)
    if (existing) {
      existing.inputTokens += e.inputTokens
      existing.outputTokens += e.outputTokens
      existing.cacheReadTokens += e.cacheReadTokens
      existing.cacheWriteTokens += e.cacheWriteTokens
      existing.messageCount += 1
    } else {
      byModel.set(e.model, {
        model: e.model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cacheReadTokens: e.cacheReadTokens,
        cacheWriteTokens: e.cacheWriteTokens,
        messageCount: 1,
      })
    }
  }

  return [...byModel.values()].sort((a, b) => b.messageCount - a.messageCount)
}

// --- File scanning ---

function scanJsonlFiles(dir: string, maxAgeDays: number): string[] {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const files: string[] = []

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const fullPath = path.join(dir, entry.name)
      try {
        const stat = fs.statSync(fullPath)
        if (stat.mtimeMs >= cutoff) {
          files.push(fullPath)
        }
      } catch {}
    }
  } catch {}

  return files
}

function scanCodexSessionDirs(baseDir: string, maxAgeDays: number): string[] {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const files: string[] = []

  try {
    // Codex stores in ~/.codex/sessions/YYYY/MM/DD/
    const walkDir = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walkDir(fullPath)
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try {
            const stat = fs.statSync(fullPath)
            if (stat.mtimeMs >= cutoff) {
              files.push(fullPath)
            }
          } catch {}
        }
      }
    }
    walkDir(baseDir)
  } catch {}

  return files
}

function parseJsonlEntries(filePath: string, extractor: (entry: any) => TokenEntry | null): TokenEntry[] {
  const entries: TokenEntry[] = []
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        const token = extractor(parsed)
        if (token) entries.push(token)
      } catch {}
    }
  } catch {}
  return entries
}

// --- Public API ---

export function scanClaudeUsage(): UsageScanResult {
  const claudeProjectsDir = path.join(homedir(), '.claude', 'projects')
  const allEntries: TokenEntry[] = []

  try {
    const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
    for (const pd of projectDirs) {
      if (!pd.isDirectory()) continue
      const projectPath = path.join(claudeProjectsDir, pd.name)
      const jsonlFiles = scanJsonlFiles(projectPath, 30)
      for (const f of jsonlFiles) {
        allEntries.push(...parseJsonlEntries(f, extractClaudeTokenUsage))
      }
    }
  } catch {}

  return buildScanResult('claude', allEntries)
}

export function scanCodexUsage(): UsageScanResult {
  const codexSessionsDir = path.join(homedir(), '.codex', 'sessions')
  const allEntries: TokenEntry[] = []

  const jsonlFiles = scanCodexSessionDirs(codexSessionsDir, 30)
  for (const f of jsonlFiles) {
    allEntries.push(...parseJsonlEntries(f, extractCodexTokenUsage))
  }

  return buildScanResult('codex', allEntries)
}

function buildScanResult(provider: 'claude' | 'codex', entries: TokenEntry[]): UsageScanResult {
  const today = new Date().toISOString().slice(0, 10)
  const todayEntries = entries.filter((e) => e.timestamp.startsWith(today))

  const todayTokensIn = todayEntries.reduce((sum, e) => sum + e.inputTokens, 0)
  const todayTokensOut = todayEntries.reduce((sum, e) => sum + e.outputTokens, 0)
  const todayCacheRead = todayEntries.reduce((sum, e) => sum + e.cacheReadTokens, 0)
  const todayCacheWrite = todayEntries.reduce((sum, e) => sum + e.cacheWriteTokens, 0)

  let todayCost = 0
  for (const e of todayEntries) {
    todayCost += estimateCostUSD(e.model, e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheWriteTokens)
  }

  return {
    provider,
    todayMessages: todayEntries.length,
    todayTokensIn,
    todayTokensOut,
    todayCostEstimate: Math.round(todayCost * 100) / 100,
    last30Days: aggregateDailyTokens(entries),
    modelBreakdown: aggregateModelSummary(entries),
    updatedAt: Date.now(),
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd apps/desktop && npx vitest run src/main/usage-scanner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/usage-scanner.ts apps/desktop/src/main/usage-scanner.test.ts
git commit -m "feat(usage): add JSONL scanner for token aggregation and cost estimation"
```

---

### Task 5: Usage Manager (orchestrator + IPC)

**Files:**
- Create: `apps/desktop/src/main/usage-manager.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`

- [ ] **Step 1: Create usage-manager.ts**

```typescript
import { BrowserWindow, ipcMain } from 'electron'
import { probeClaudeUsage, probeCodexUsage } from './usage-probe'
import { scanClaudeUsage, scanCodexUsage } from './usage-scanner'
import type { UsageSnapshot } from '../shared/types'

const PROBE_INTERVAL_MS = 60_000   // poll CLI every 60s
const SCAN_INTERVAL_MS = 300_000   // scan JSONL every 5 min

let mainWindow: BrowserWindow | null = null
let probeTimer: ReturnType<typeof setInterval> | null = null
let scanTimer: ReturnType<typeof setInterval> | null = null

let currentSnapshot: UsageSnapshot = {
  claude: { probe: null, scan: null },
  codex: { probe: null, scan: null },
}

function emit(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('usage-update', currentSnapshot)
  }
}

async function runProbes(): Promise<void> {
  const [claude, codex] = await Promise.allSettled([
    probeClaudeUsage(),
    probeCodexUsage(),
  ])

  if (claude.status === 'fulfilled') {
    currentSnapshot.claude.probe = claude.value
  }
  if (codex.status === 'fulfilled') {
    currentSnapshot.codex.probe = codex.value
  }

  emit()
}

function runScans(): void {
  try {
    currentSnapshot.claude.scan = scanClaudeUsage()
  } catch {}
  try {
    currentSnapshot.codex.scan = scanCodexUsage()
  } catch {}

  emit()
}

export function initUsageManager(window: BrowserWindow): void {
  mainWindow = window

  ipcMain.handle('get-usage-snapshot', () => currentSnapshot)
  ipcMain.handle('refresh-usage', async () => {
    await runProbes()
    runScans()
  })

  // Initial fetch
  runScans()
  void runProbes()

  // Periodic polling
  probeTimer = setInterval(() => void runProbes(), PROBE_INTERVAL_MS)
  scanTimer = setInterval(runScans, SCAN_INTERVAL_MS)
}

export function stopUsageManager(): void {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null }
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null }
  mainWindow = null

  try { ipcMain.removeHandler('get-usage-snapshot') } catch {}
  try { ipcMain.removeHandler('refresh-usage') } catch {}
}
```

- [ ] **Step 2: Wire into main/index.ts**

Add import at top of `apps/desktop/src/main/index.ts` (after line ~48, with other imports):

```typescript
import { initUsageManager, stopUsageManager } from './usage-manager'
```

Add initialization call after `initUpdater(mainWindow)` (around line 168):

```typescript
  initUsageManager(mainWindow)
```

Add cleanup in the close handler (around line 199, alongside other stop calls):

```typescript
      stopUsageManager()
```

- [ ] **Step 3: Wire preload IPC**

Add to `apps/desktop/src/preload/index.ts`, in the `api` object (after the auto-update section, around line 311):

```typescript
  // Usage tracking
  getUsageSnapshot: () => ipcRenderer.invoke('get-usage-snapshot'),
  onUsageUpdate: (callback: (snapshot: any) => void) => {
    const handler = (_event: any, snapshot: any) => callback(snapshot)
    ipcRenderer.on('usage-update', handler)
    return () => { ipcRenderer.removeListener('usage-update', handler) }
  },
  refreshUsage: () => ipcRenderer.invoke('refresh-usage'),
```

Inside the `removeAllListeners` function, add before its closing brace (after the last `removeAllListeners` call for `'agent-session-state'`):

```typescript
    ipcRenderer.removeAllListeners('usage-update')
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/usage-manager.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts
git commit -m "feat(usage): add usage manager with IPC plumbing"
```

---

### Task 6: UsageBar Component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/UsageBar.tsx`

- [ ] **Step 1: Create reusable progress bar component**

```tsx
interface UsageBarProps {
  percent: number // 0-100
  label?: string
  size?: 'sm' | 'md'
  textColor: string
}

function barColor(percent: number): string {
  if (percent >= 80) return '#ef4444' // red
  if (percent >= 50) return '#eab308' // yellow
  return '#22c55e' // green
}

export function UsageBar({ percent, label, size = 'sm', textColor }: UsageBarProps) {
  const clamped = Math.max(0, Math.min(100, percent))
  const height = size === 'sm' ? 'h-1' : 'h-2'

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {label && (
        <span className="text-[10px] font-mono shrink-0 opacity-60" style={{ color: textColor }}>
          {label}
        </span>
      )}
      <div
        className={`flex-1 ${height} rounded-full overflow-hidden min-w-[32px]`}
        style={{ backgroundColor: `${textColor}15` }}
      >
        <div
          className={`${height} rounded-full transition-all duration-500`}
          style={{
            width: `${clamped}%`,
            backgroundColor: barColor(clamped),
          }}
        />
      </div>
      <span className="text-[10px] font-mono shrink-0" style={{ color: textColor }}>
        {Math.round(clamped)}%
      </span>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/UsageBar.tsx
git commit -m "feat(usage): add UsageBar progress component"
```

---

### Task 7: UsageBadge Component (NavBar)

**Files:**
- Create: `apps/desktop/src/renderer/src/components/UsageBadge.tsx`
- Modify: `apps/desktop/src/renderer/src/components/NavBar.tsx`

- [ ] **Step 1: Create the compact badge component**

Create `apps/desktop/src/renderer/src/components/UsageBadge.tsx`:

```tsx
import { useState, useEffect } from 'react'
import { Tooltip } from './Tooltip'
import type { UsageSnapshot } from '../../../shared/types'

interface UsageBadgeProps {
  wsColor: string
  textColor: string
  onClick: () => void
}

function percentColor(pct: number): string {
  if (pct >= 80) return '#ef4444'
  if (pct >= 50) return '#eab308'
  return '#22c55e'
}

function MiniBar({ percent, textColor }: { percent: number; textColor: string }) {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <div
      className="w-[20px] h-[3px] rounded-full overflow-hidden"
      style={{ backgroundColor: `${textColor}20` }}
    >
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{
          width: `${clamped}%`,
          backgroundColor: percentColor(clamped),
        }}
      />
    </div>
  )
}

export function UsageBadge({ wsColor, textColor, onClick }: UsageBadgeProps) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)

  useEffect(() => {
    window.electronAPI.getUsageSnapshot().then(setSnapshot)
    const unsub = window.electronAPI.onUsageUpdate(setSnapshot)
    return unsub
  }, [])

  // Derive the best available session/weekly percentages (prefer Claude, fallback Codex)
  const claudeSession = snapshot?.claude?.probe?.session?.usedPercent
  const claudeWeekly = snapshot?.claude?.probe?.weekly?.usedPercent
  const codexSession = snapshot?.codex?.probe?.session?.usedPercent
  const codexWeekly = snapshot?.codex?.probe?.weekly?.usedPercent

  const sessionPct = claudeSession ?? codexSession ?? null
  const weeklyPct = claudeWeekly ?? codexWeekly ?? null

  // Don't render until we have data
  if (sessionPct === null && weeklyPct === null) return null

  const tooltipParts: string[] = []
  if (claudeSession != null) tooltipParts.push(`Claude session: ${Math.round(claudeSession)}%`)
  if (claudeWeekly != null) tooltipParts.push(`Claude weekly: ${Math.round(claudeWeekly)}%`)
  if (codexSession != null) tooltipParts.push(`Codex session: ${Math.round(codexSession)}%`)
  if (codexWeekly != null) tooltipParts.push(`Codex weekly: ${Math.round(codexWeekly)}%`)

  return (
    <Tooltip side="top" text={tooltipParts.join(' | ')} bgColor={wsColor} textColor={textColor}>
      <button
        onClick={onClick}
        className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-mono transition-colors hover:opacity-80"
        style={{
          color: textColor,
          backgroundColor: `${textColor}10`,
          border: `1px solid ${textColor}18`,
        }}
      >
        {/* Session usage */}
        {sessionPct !== null && (
          <span className="flex items-center gap-1">
            <span className="opacity-50">S</span>
            <MiniBar percent={sessionPct} textColor={textColor} />
            <span style={{ color: percentColor(sessionPct) }}>
              {Math.round(sessionPct)}%
            </span>
          </span>
        )}

        {/* Separator */}
        {sessionPct !== null && weeklyPct !== null && (
          <span className="opacity-20">|</span>
        )}

        {/* Weekly usage */}
        {weeklyPct !== null && (
          <span className="flex items-center gap-1">
            <span className="opacity-50">W</span>
            <MiniBar percent={weeklyPct} textColor={textColor} />
            <span style={{ color: percentColor(weeklyPct) }}>
              {Math.round(weeklyPct)}%
            </span>
          </span>
        )}
      </button>
    </Tooltip>
  )
}
```

- [ ] **Step 2: Add UsageBadge to NavBar**

In `apps/desktop/src/renderer/src/components/NavBar.tsx`:

Add import at top (after existing imports):

```typescript
import { UsageBadge } from './UsageBadge'
```

Add state for panel toggle. In the NavBar component, add:

```typescript
  const showUsagePanel = useAppStore((s) => s.showUsagePanel)
  const toggleUsagePanel = useAppStore((s) => s.toggleUsagePanel)
```

Add the badge in the right-aligned badges section, before the Skills button (around line 157, inside the `<div className="flex items-center gap-1.5 px-2 shrink-0">` div):

```tsx
          {/* Usage badge */}
          <UsageBadge
            wsColor={wsColor}
            textColor={txtColor}
            onClick={toggleUsagePanel}
          />
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/UsageBadge.tsx apps/desktop/src/renderer/src/components/NavBar.tsx
git commit -m "feat(usage): add compact usage badge to NavBar"
```

---

### Task 8: UsagePanel Component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/UsagePanel.tsx`

- [ ] **Step 1: Create the full stats panel**

Create `apps/desktop/src/renderer/src/components/UsagePanel.tsx`:

```tsx
import { useState, useEffect } from 'react'
import { useAppStore } from '../store/app-store'
import { textColor } from '../utils/color'
import { darkenColor } from './TerminalArea'
import { UsageBar } from './UsageBar'
import type { UsageSnapshot, UsageScanResult, UsageProbeResult, DailyTokenEntry } from '../../../shared/types'

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

// Simple 30-day bar chart
function DailyChart({ data, textColor: txtColor }: { data: DailyTokenEntry[]; textColor: string }) {
  if (data.length === 0) return null
  const maxTokens = Math.max(...data.map((d) => d.inputTokens + d.outputTokens), 1)

  return (
    <div className="flex items-end gap-px h-[60px]">
      {data.slice(-30).map((day) => {
        const total = day.inputTokens + day.outputTokens
        const height = Math.max(1, (total / maxTokens) * 100)
        const isToday = day.date === new Date().toISOString().slice(0, 10)
        return (
          <div
            key={day.date}
            className="flex-1 min-w-[2px] rounded-t-sm transition-all"
            style={{
              height: `${height}%`,
              backgroundColor: isToday ? '#22c55e' : `${txtColor}30`,
            }}
            title={`${day.date}: ${formatTokens(total)} tokens`}
          />
        )
      })}
    </div>
  )
}

function ProviderSection({
  label,
  probe,
  scan,
  txtColor,
}: {
  label: string
  probe: UsageProbeResult | null
  scan: UsageScanResult | null
  txtColor: string
}) {
  const hasProbe = probe && !probe.error
  const hasScan = scan && scan.todayMessages > 0

  if (!hasProbe && !hasScan) return null

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold tracking-wider uppercase opacity-60" style={{ color: txtColor }}>
        {label}
      </div>

      {/* Rate limits */}
      {hasProbe && (
        <div className="space-y-1.5">
          {probe.session && (
            <UsageBar
              percent={probe.session.usedPercent}
              label="Session"
              size="md"
              textColor={txtColor}
            />
          )}
          {probe.weekly && (
            <UsageBar
              percent={probe.weekly.usedPercent}
              label="Weekly"
              size="md"
              textColor={txtColor}
            />
          )}
          {(probe.session?.resetsAt || probe.weekly?.resetsAt) && (
            <div className="text-[10px] font-mono opacity-40" style={{ color: txtColor }}>
              {probe.session?.resetsAt && `Session resets ${probe.session.resetsAt}`}
              {probe.session?.resetsAt && probe.weekly?.resetsAt && ' · '}
              {probe.weekly?.resetsAt && `Weekly resets ${probe.weekly.resetsAt}`}
            </div>
          )}
        </div>
      )}

      {/* Today stats */}
      {hasScan && (
        <div className="grid grid-cols-3 gap-2">
          <div>
            <div className="text-[10px] opacity-40" style={{ color: txtColor }}>Messages</div>
            <div className="text-sm font-mono" style={{ color: txtColor }}>{scan.todayMessages}</div>
          </div>
          <div>
            <div className="text-[10px] opacity-40" style={{ color: txtColor }}>Tokens</div>
            <div className="text-sm font-mono" style={{ color: txtColor }}>
              {formatTokens(scan.todayTokensIn + scan.todayTokensOut)}
            </div>
          </div>
          <div>
            <div className="text-[10px] opacity-40" style={{ color: txtColor }}>Est. Cost</div>
            <div className="text-sm font-mono" style={{ color: txtColor }}>
              {formatCost(scan.todayCostEstimate)}
            </div>
          </div>
        </div>
      )}

      {/* 30-day chart */}
      {scan && scan.last30Days.length > 0 && (
        <div>
          <div className="text-[10px] opacity-40 mb-1" style={{ color: txtColor }}>Last 30 days</div>
          <DailyChart data={scan.last30Days} textColor={txtColor} />
        </div>
      )}

      {/* Model breakdown */}
      {scan && scan.modelBreakdown.length > 0 && (
        <div>
          <div className="text-[10px] opacity-40 mb-1" style={{ color: txtColor }}>Models</div>
          <div className="space-y-1">
            {scan.modelBreakdown.map((m) => (
              <div key={m.model} className="flex items-center justify-between text-[10px] font-mono" style={{ color: txtColor }}>
                <span className="opacity-60 truncate mr-2">{m.model}</span>
                <span>{formatTokens(m.inputTokens + m.outputTokens)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function UsagePanel({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const ws = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const wsColor = ws?.color ?? '#2a2a3e'
  const txtColor = textColor(wsColor)
  const panelBg = darkenColor(wsColor)

  useEffect(() => {
    window.electronAPI.getUsageSnapshot().then(setSnapshot)
    const unsub = window.electronAPI.onUsageUpdate(setSnapshot)
    return unsub
  }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    await window.electronAPI.refreshUsage()
    setRefreshing(false)
  }

  return (
    <div
      className="w-[280px] shrink-0 border-l flex flex-col overflow-y-auto"
      style={{
        backgroundColor: panelBg,
        borderColor: `${txtColor}15`,
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 shrink-0" style={{ borderBottom: `1px solid ${txtColor}15` }}>
        <span className="text-xs font-semibold tracking-wider uppercase" style={{ color: txtColor }}>
          Usage
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="p-1 rounded hover:opacity-80 transition-opacity"
            style={{ color: txtColor }}
            title="Refresh"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={refreshing ? 'animate-spin' : ''}>
              <path d="M2 8a6 6 0 0 1 10.3-4.2" />
              <path d="M14 8a6 6 0 0 1-10.3 4.2" />
              <polyline points="2 2 2 6 6 6" />
              <polyline points="14 14 14 10 10 10" />
            </svg>
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:opacity-80 transition-opacity"
            style={{ color: txtColor }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-5">
        {!snapshot && (
          <div className="text-[10px] font-mono opacity-40 text-center py-8" style={{ color: txtColor }}>
            Loading usage data...
          </div>
        )}

        {snapshot && (
          <>
            <ProviderSection
              label="Claude"
              probe={snapshot.claude.probe}
              scan={snapshot.claude.scan}
              txtColor={txtColor}
            />
            <ProviderSection
              label="Codex"
              probe={snapshot.codex.probe}
              scan={snapshot.codex.scan}
              txtColor={txtColor}
            />

            {!snapshot.claude.probe && !snapshot.codex.probe && !snapshot.claude.scan?.todayMessages && !snapshot.codex.scan?.todayMessages && (
              <div className="text-[10px] font-mono opacity-40 text-center py-8" style={{ color: txtColor }}>
                No usage data available yet.
                <br />
                Make sure claude or codex CLI is installed.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/UsagePanel.tsx
git commit -m "feat(usage): add full UsagePanel with charts and stats"
```

---

### Task 9: App Store + App Layout Integration

**Files:**
- Modify: `apps/desktop/src/renderer/src/store/app-store.ts`
- Modify: `apps/desktop/src/renderer/src/App.tsx`

- [ ] **Step 1: Add usage panel state to app-store**

In `apps/desktop/src/renderer/src/store/app-store.ts`:

Add `showUsagePanel: boolean` after `showAutomationRunsPanel: boolean` (line 259).
Add `toggleUsagePanel: () => void` after `closeAutomationRunsPanel: () => void` (line 264).

```typescript
  showUsagePanel: boolean
  toggleUsagePanel: () => void
```

In the `create()` call, add initial state after `showAutomationRunsPanel: false` (line 345):

```typescript
  showUsagePanel: false,
```

Add the toggle action after the `toggleDiffPanel` action (around line 357):

```typescript
  toggleUsagePanel: () => set((s) => ({ showUsagePanel: !s.showUsagePanel })),
```

- [ ] **Step 2: Add UsagePanel to App.tsx**

In `apps/desktop/src/renderer/src/App.tsx`:

Add import:

```typescript
import { UsagePanel } from './components/UsagePanel'
```

Add store selectors (near the other panel selectors):

```typescript
  const showUsagePanel = useAppStore((s) => s.showUsagePanel)
  const toggleUsagePanel = useAppStore((s) => s.toggleUsagePanel)
```

Add the panel render next to the DiffPanel and AutomationRunsPanel (around line 260-261):

```tsx
              {showUsagePanel && <UsagePanel onClose={toggleUsagePanel} />}
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/store/app-store.ts apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(usage): integrate UsagePanel into app layout"
```

---

### Task 10: Build Verification

- [ ] **Step 1: Run all usage tests**

Run: `cd apps/desktop && npx vitest run src/main/usage-probe.test.ts src/main/usage-scanner.test.ts`
Expected: All PASS

- [ ] **Step 2: TypeScript check**

Run: `cd apps/desktop && bun run typecheck`
Expected: No new errors (existing baseline errors are OK; project uses `tsgo --noEmit`)

- [ ] **Step 3: Build the app**

Run: `cd apps/desktop && bun run build`
Expected: Build succeeds

- [ ] **Step 4: Commit any fixes needed**

If any type errors or build issues, fix and commit.

---

### Task 11: Manual Smoke Test

- [ ] **Step 1: Run dev mode**

Run: `bun run dev` in the root

- [ ] **Step 2: Verify badge appears**

Look for the usage badge (S: XX% | W: XX%) in the NavBar footer, right side, next to the Skills and memory badges.

- [ ] **Step 3: Verify panel opens**

Click the badge — the UsagePanel should slide in from the right showing Claude and/or Codex sections with rate limit bars, today's stats, 30-day chart, and model breakdown.

- [ ] **Step 4: Verify refresh**

Click the refresh button in the panel header — data should reload.
