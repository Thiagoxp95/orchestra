import { BrowserWindow, ipcMain } from 'electron'
import { probeClaudeUsage, probeCodexUsage } from './usage-probe'
import { scanClaudeUsage, scanCodexUsage } from './usage-scanner'
import { computeClaudeCooldown, nextProbeDelayMs } from './usage-cooldown'
import type { UsageSnapshot } from '../shared/types'

// Claude's /api/oauth/usage endpoint 429s aggressively at anything below ~10
// minutes and rarely sends Retry-After (see anthropics/claude-code#31637).
// 15 min base with ±20% jitter keeps us well under the threshold and avoids
// synchronized bursts when many instances share an account.
const PROBE_INTERVAL_MS = 15 * 60_000
const SCAN_INTERVAL_MS = 5 * 60_000

let mainWindow: BrowserWindow | null = null
let probeTimer: ReturnType<typeof setTimeout> | null = null
let scanTimer: ReturnType<typeof setInterval> | null = null
let claudeCooldownUntilMs = 0
let claudeConsecutiveRateLimits = 0

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
  // backoff window.
  const claudePromise: Promise<typeof currentSnapshot.claude.probe> =
    claudeCooldownUntilMs > Date.now()
      ? Promise.resolve(currentSnapshot.claude.probe)
      : probeClaudeUsage()

  const [claude, codex] = await Promise.allSettled([
    claudePromise,
    probeCodexUsage(),
  ])

  if (claude.status === 'fulfilled' && claude.value) {
    const probe = claude.value

    if (probe.cooldownUntil) {
      // 429 — escalate our own backoff based on consecutive failures, using
      // any server-provided Retry-After as a lower bound.
      claudeConsecutiveRateLimits += 1
      const escalatedUntil = computeClaudeCooldown(
        claudeConsecutiveRateLimits,
        probe.cooldownUntil,
      )
      claudeCooldownUntilMs = escalatedUntil
      const waitMs = escalatedUntil - Date.now()
      console.warn(
        `[usage-manager] Claude probe cooling down for ${Math.round(waitMs / 1000)}s (consecutive: ${claudeConsecutiveRateLimits})`,
      )
      currentSnapshot.claude.probe = { ...probe, cooldownUntil: escalatedUntil }
    } else {
      if (probe.error === null && claudeConsecutiveRateLimits > 0) {
        console.info(
          `[usage-manager] Claude probe recovered after ${claudeConsecutiveRateLimits} consecutive rate limits`,
        )
        claudeConsecutiveRateLimits = 0
      }
      currentSnapshot.claude.probe = probe
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

function scheduleNextProbe(): void {
  const delay = nextProbeDelayMs(PROBE_INTERVAL_MS)
  probeTimer = setTimeout(async () => {
    try {
      await runProbes()
    } finally {
      scheduleNextProbe()
    }
  }, delay)
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

  // Periodic polling — probe via jittered self-rescheduling setTimeout; scan
  // is cheap local IO and can stay on a fixed cadence.
  scheduleNextProbe()
  scanTimer = setInterval(() => void runScans(), SCAN_INTERVAL_MS)
}

export function stopUsageManager(): void {
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null }
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null }
  mainWindow = null

  try { ipcMain.removeHandler('get-usage-snapshot') } catch {}
  try { ipcMain.removeHandler('refresh-usage') } catch {}
}
