// usage-manager.ts — Coordinates usage probes/scans across providers.
//
// Mirrors ClaudeBar's QuotaMonitor architecture (Sources/Domain/Monitor/
// QuotaMonitor.swift):
//   - Each provider owns its own state (probe/scan/isSyncing).
//   - The manager coordinates refreshes; callers ask it to refresh by id.
//   - In-flight `isSyncing` dedupes concurrent refreshes per provider.
//   - Background sync is off by default and refreshes only the *selected*
//     provider when enabled (UI flips selection on tab switch / panel mount).
//   - No client-side rate-limit backoff: errors surface in the snapshot so
//     the UI can show them; the user can retry whenever they want.
//
// The renderer drives freshness by calling `refresh-usage` on panel mount,
// provider switch, and manual refresh — same pattern as ClaudeBar's
// `.task { await refresh(providerId:) }` in MenuContentView.

import { BrowserWindow, ipcMain } from 'electron'
import { probeClaudeUsage, probeCodexUsage } from './usage-probe'
import { scanClaudeUsage, scanCodexUsage } from './usage-scanner'
import {
  loadUsageBackgroundSync,
  saveUsageBackgroundSync,
} from './persistence'
import type {
  UsageBackgroundSyncSettings,
  UsageProbeResult,
  UsageProviderId,
  UsageProviderState,
  UsageSnapshot,
} from '../shared/types'

const SCAN_INTERVAL_MS = 5 * 60_000
const MIN_BG_SYNC_SECONDS = 30
// One-shot retry window for the cold-start probe. Anthropic's OAuth usage
// endpoint occasionally fails the very first call (network warming up,
// transient 429, keychain stalled) which used to leave Claude hidden from
// the footer until the user hovered. A single delayed retry recovers without
// reintroducing periodic 429-bait.
const COLD_START_RETRY_DELAY_MS = 20_000
const DEFAULT_BG_SYNC: UsageBackgroundSyncSettings = {
  enabled: false,
  intervalSeconds: 60,
}

let mainWindow: BrowserWindow | null = null
let scanTimer: ReturnType<typeof setInterval> | null = null
let bgSyncTimer: ReturnType<typeof setTimeout> | null = null
let coldStartRetryTimer: ReturnType<typeof setTimeout> | null = null
let bgSyncSettings: UsageBackgroundSyncSettings = DEFAULT_BG_SYNC
let selectedProviderId: UsageProviderId = 'claude'

const inflight: Record<UsageProviderId, Promise<void> | null> = {
  claude: null,
  codex: null,
}

function emptyState(): UsageProviderState {
  return { probe: null, scan: null, isSyncing: false }
}

let snapshot: UsageSnapshot = {
  claude: emptyState(),
  codex: emptyState(),
}

function emit(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('usage-update', snapshot)
  }
}

// When a probe fails (rate-limit, network error, token blip) the API returns
// `{ session: null, weekly: null, error }`. Replacing the snapshot with that
// wipes the last good numbers and the footer badge — which only renders
// providers with at least one usable window — drops the entry entirely until
// the user hovers and triggers another probe. Preserve the previous data and
// surface the new error instead so the badge keeps showing what we know.
export function mergeProbeResult(
  previous: UsageProbeResult | null,
  next: UsageProbeResult,
): UsageProbeResult {
  const nextHasData = next.session !== null || next.weekly !== null
  const previousHasData = !!previous && (previous.session !== null || previous.weekly !== null)
  if (nextHasData || !previousHasData) return next
  return {
    ...previous!,
    error: next.error,
    updatedAt: previous!.updatedAt,
  }
}

function setSyncing(providerId: UsageProviderId, isSyncing: boolean): void {
  snapshot[providerId] = { ...snapshot[providerId], isSyncing }
  emit()
}

async function probeProvider(providerId: UsageProviderId): Promise<void> {
  if (inflight[providerId]) return inflight[providerId]!

  const task = (async () => {
    setSyncing(providerId, true)
    try {
      let next: UsageProbeResult
      try {
        next =
          providerId === 'claude' ? await probeClaudeUsage() : await probeCodexUsage()
      } catch (err) {
        console.warn(`[usage-manager] ${providerId} probe threw:`, err)
        // Fall back to an empty error probe so the badge has *something* to
        // render — leaving probe null hides the provider from the footer
        // entirely until the next refresh.
        next = {
          provider: providerId,
          session: null,
          weekly: null,
          error: err instanceof Error ? err.message : 'Probe failed',
          updatedAt: Date.now(),
        }
      }
      const merged = mergeProbeResult(snapshot[providerId].probe, next)
      snapshot[providerId] = { ...snapshot[providerId], probe: merged }
    } finally {
      setSyncing(providerId, false)
    }
  })()

  inflight[providerId] = task
  try {
    await task
  } finally {
    inflight[providerId] = null
  }
}

async function refreshAll(): Promise<void> {
  await Promise.allSettled([probeProvider('claude'), probeProvider('codex')])
}

async function refreshSelected(): Promise<void> {
  await probeProvider(selectedProviderId)
}

async function runScans(): Promise<void> {
  try {
    snapshot.claude = { ...snapshot.claude, scan: await scanClaudeUsage() }
  } catch {}
  try {
    snapshot.codex = { ...snapshot.codex, scan: await scanCodexUsage() }
  } catch {}
  emit()
}

function clearBgSyncTimer(): void {
  if (bgSyncTimer) {
    clearTimeout(bgSyncTimer)
    bgSyncTimer = null
  }
}

function scheduleNextBgSync(): void {
  clearBgSyncTimer()
  if (!bgSyncSettings.enabled) return
  const delay = Math.max(MIN_BG_SYNC_SECONDS, bgSyncSettings.intervalSeconds) * 1000
  bgSyncTimer = setTimeout(async () => {
    try {
      await refreshSelected()
    } finally {
      scheduleNextBgSync()
    }
  }, delay)
}

function applyBgSyncSettings(next: UsageBackgroundSyncSettings): void {
  bgSyncSettings = {
    enabled: !!next.enabled,
    intervalSeconds: Math.max(MIN_BG_SYNC_SECONDS, next.intervalSeconds | 0 || DEFAULT_BG_SYNC.intervalSeconds),
  }
  scheduleNextBgSync()
}

export function initUsageManager(window: BrowserWindow): void {
  mainWindow = window

  bgSyncSettings = loadUsageBackgroundSync() ?? DEFAULT_BG_SYNC

  ipcMain.handle('get-usage-snapshot', () => snapshot)
  ipcMain.handle('refresh-usage', async (_e, providerId?: UsageProviderId) => {
    if (providerId === 'claude' || providerId === 'codex') {
      selectedProviderId = providerId
      await probeProvider(providerId)
    } else {
      await refreshAll()
    }
    await runScans()
  })
  ipcMain.handle('get-usage-bg-sync', () => bgSyncSettings)
  ipcMain.handle('set-usage-bg-sync', (_e, next: UsageBackgroundSyncSettings) => {
    applyBgSyncSettings(next)
    saveUsageBackgroundSync(bgSyncSettings)
    return bgSyncSettings
  })

  // Initial fetch — ClaudeBar fetches on first menu open; we fetch on init so
  // status indicators (menu bar / footer) have data before the user opens the
  // Usage panel.
  void runScans()
  void (async () => {
    await refreshAll()
    // If Claude's first probe came back empty (network warming up, transient
    // 429, keychain stalled), retry once shortly after so the badge isn't
    // stuck without data until the user hovers.
    const claudeProbe = snapshot.claude.probe
    const claudeHasData = !!claudeProbe && (claudeProbe.session !== null || claudeProbe.weekly !== null)
    if (!claudeHasData) {
      if (coldStartRetryTimer) clearTimeout(coldStartRetryTimer)
      coldStartRetryTimer = setTimeout(() => {
        coldStartRetryTimer = null
        void probeProvider('claude')
      }, COLD_START_RETRY_DELAY_MS)
    }
  })()

  scanTimer = setInterval(() => void runScans(), SCAN_INTERVAL_MS)
  scheduleNextBgSync()
}

export function stopUsageManager(): void {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null }
  clearBgSyncTimer()
  if (coldStartRetryTimer) { clearTimeout(coldStartRetryTimer); coldStartRetryTimer = null }
  mainWindow = null

  try { ipcMain.removeHandler('get-usage-snapshot') } catch {}
  try { ipcMain.removeHandler('refresh-usage') } catch {}
  try { ipcMain.removeHandler('get-usage-bg-sync') } catch {}
  try { ipcMain.removeHandler('set-usage-bg-sync') } catch {}
}
