// usage-probe.ts — Parse CLI usage output from Claude /usage and Codex /status

import * as pty from 'node-pty'
import { execSync } from 'node:child_process'
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
// Binary resolution
// ---------------------------------------------------------------------------

function resolveBinary(name: string): string | null {
  try {
    return execSync(`which ${name}`, { encoding: 'utf-8' }).trim() || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Generic PTY runner
// ---------------------------------------------------------------------------

function runPtyCommand(
  binary: string,
  args: string[],
  command: string,
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    let commandSent = false
    let terminated = false

    const term = pty.spawn(binary, args, {
      name: 'xterm-256color',
      cols: 200,
      rows: 60,
      env: { ...process.env, TERM: 'xterm-256color' },
    })

    const timeout = setTimeout(() => {
      if (!terminated) {
        terminated = true
        term.kill()
        resolve(output)
      }
    }, timeoutMs)

    term.onData((data: string) => {
      if (commandSent) {
        output += data
      }

      // Early termination: we have percentage and reset info
      if (commandSent && PCT_RE.test(output) && RESET_RE.test(output)) {
        // Buffer 500ms to collect remaining output
        if (!terminated) {
          setTimeout(() => {
            if (!terminated) {
              terminated = true
              clearTimeout(timeout)
              term.kill()
              resolve(output)
            }
          }, 500)
        }
      }
    })

    term.onExit(() => {
      if (!terminated) {
        terminated = true
        clearTimeout(timeout)
        resolve(output)
      }
    })

    // Wait 2s for CLI initialization before sending command
    setTimeout(() => {
      if (!terminated) {
        commandSent = true
        term.write(command)
      }
    }, 2000)
  })
}

// ---------------------------------------------------------------------------
// Public probe functions
// ---------------------------------------------------------------------------

export async function probeClaudeUsage(): Promise<UsageProbeResult> {
  const binary = resolveBinary('claude')
  if (!binary) {
    return {
      provider: 'claude',
      session: null,
      weekly: null,
      error: 'claude binary not found',
      updatedAt: Date.now(),
    }
  }

  try {
    const raw = await runPtyCommand(binary, [], '/usage\n')
    const parsed = parseClaudeUsageOutput(raw)
    return {
      provider: 'claude',
      session: parsed.session,
      weekly: parsed.weekly,
      error: parsed.error,
      updatedAt: Date.now(),
    }
  } catch (err) {
    return {
      provider: 'claude',
      session: null,
      weekly: null,
      error: err instanceof Error ? err.message : String(err),
      updatedAt: Date.now(),
    }
  }
}

export async function probeCodexUsage(): Promise<UsageProbeResult> {
  const binary = resolveBinary('codex')
  if (!binary) {
    return {
      provider: 'codex',
      session: null,
      weekly: null,
      error: 'codex binary not found',
      updatedAt: Date.now(),
    }
  }

  try {
    const raw = await runPtyCommand(binary, [], '/status\n')
    const parsed = parseCodexStatusOutput(raw)
    return {
      provider: 'codex',
      session: parsed.session,
      weekly: parsed.weekly,
      error: parsed.error,
      updatedAt: Date.now(),
    }
  } catch (err) {
    return {
      provider: 'codex',
      session: null,
      weekly: null,
      error: err instanceof Error ? err.message : String(err),
      updatedAt: Date.now(),
    }
  }
}
