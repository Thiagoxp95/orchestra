import { BrowserWindow, ipcMain } from 'electron'
import { probeClaudeUsage, probeCodexUsage } from './usage-probe'
import { scanClaudeUsage, scanCodexUsage } from './usage-scanner'
import type { UsageSnapshot } from '../shared/types'

// Claude OAuth usage endpoint rate-limits aggressive polling. 5 min gives us
// fresh-enough rate-window data without getting 429'd, and the cooldown below
// still suppresses probes whenever a 429 does come back.
const PROBE_INTERVAL_MS = 300_000  // 5 min
const SCAN_INTERVAL_MS = 300_000   // scan JSONL every 5 min

let mainWindow: BrowserWindow | null = null
let probeTimer: ReturnType<typeof setInterval> | null = null
let scanTimer: ReturnType<typeof setInterval> | null = null
let claudeCooldownUntilMs = 0

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
  // Respect the Claude cooldown on *every* path — including manual refresh
  // clicks — because hammering the endpoint while 429'd only extends the
  // Retry-After window Anthropic keeps telling us about.
  const claudePromise: Promise<typeof currentSnapshot.claude.probe> =
    claudeCooldownUntilMs > Date.now()
      ? Promise.resolve(currentSnapshot.claude.probe)
      : probeClaudeUsage()

  const [claude, codex] = await Promise.allSettled([
    claudePromise,
    probeCodexUsage(),
  ])

  if (claude.status === 'fulfilled' && claude.value) {
    currentSnapshot.claude.probe = claude.value
    if (claude.value.cooldownUntil && claude.value.cooldownUntil > claudeCooldownUntilMs) {
      claudeCooldownUntilMs = claude.value.cooldownUntil
      const waitMs = claudeCooldownUntilMs - Date.now()
      console.warn(`[usage-manager] Claude probe cooling down for ${Math.round(waitMs / 1000)}s`)
    }
  }
  if (codex.status === 'fulfilled') {
    currentSnapshot.codex.probe = codex.value
  }

  emit()
}

async function runScans(): Promise<void> {
  try {
    currentSnapshot.claude.scan = await scanClaudeUsage()
  } catch {}
  try {
    currentSnapshot.codex.scan = await scanCodexUsage()
  } catch {}

  emit()
}

export function initUsageManager(window: BrowserWindow): void {
  mainWindow = window

  ipcMain.handle('get-usage-snapshot', () => currentSnapshot)
  ipcMain.handle('refresh-usage', async () => {
    await runProbes()
    await runScans()
  })

  // Initial fetch
  void runScans()
  void runProbes()

  // Periodic polling
  probeTimer = setInterval(() => void runProbes(), PROBE_INTERVAL_MS)
  scanTimer = setInterval(() => void runScans(), SCAN_INTERVAL_MS)
}

export function stopUsageManager(): void {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null }
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null }
  mainWindow = null

  try { ipcMain.removeHandler('get-usage-snapshot') } catch {}
  try { ipcMain.removeHandler('refresh-usage') } catch {}
}
