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
