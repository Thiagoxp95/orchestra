// usage-manager.ts — Coordinates usage probes/scans across providers.
//
// Mirrors ClaudeBar's QuotaMonitor architecture (Sources/Domain/Monitor/
// QuotaMonitor.swift):
//   - Each provider owns its own state (probe/scan/isSyncing).
//   - The manager coordinates refreshes; callers ask it to refresh by id.
//   - In-flight `isSyncing` dedupes concurrent refreshes per provider.
//
// Background sync runs two independent poll loops so the footer badge stays
// fresh without the user hovering — the two providers have very different
// costs:
//   - Codex usage comes from local JSONL session logs (~/.codex/sessions),
//     so it has ZERO network cost and zero 429 risk. We poll it on a tight
//     interval → effectively realtime.
//   - Claude usage can only come from Anthropic's OAuth usage endpoint
//     (its local logs only record limits once you *hit* one, never the live
//     utilization). That endpoint has its own request rate limit, so we poll
//     it gently and apply exponential backoff whenever it 429s / errors,
//     resetting to the base cadence on the next success. Polling it does NOT
//     consume the 5h/weekly quota — it returns metadata only.
//
// The renderer still drives extra freshness by calling `refresh-usage` on
// panel mount, provider switch, hover, and manual refresh.

import { BrowserWindow, ipcMain } from 'electron'
import { remoteBridgeOnUsage } from './remote-bridge'
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
// Codex is a local-file scan — cheap enough to poll aggressively so the badge
// tracks Codex usage in near-realtime as the user burns through a session.
const CODEX_POLL_INTERVAL_MS = 15_000
// Claude's base cadence when the endpoint is healthy. Gentle by design: this
// is the network path, and it's the only 429 source.
const CLAUDE_BACKOFF_START_MS = 60_000
// Backoff ceiling after repeated 429s / errors.
const CLAUDE_BACKOFF_MAX_MS = 10 * 60_000
// One-shot retry window for the cold-start probe. Anthropic's OAuth usage
// endpoint occasionally fails the very first call (network warming up,
// transient 429, keychain stalled) which used to leave Claude hidden from
// the footer until the user hovered. A single delayed retry recovers without
// reintroducing periodic 429-bait.
const COLD_START_RETRY_DELAY_MS = 20_000
const DEFAULT_BG_SYNC: UsageBackgroundSyncSettings = {
  enabled: true,
  intervalSeconds: 60,
}

let mainWindow: BrowserWindow | null = null
let scanTimer: ReturnType<typeof setInterval> | null = null
let codexPollTimer: ReturnType<typeof setTimeout> | null = null
let claudePollTimer: ReturnType<typeof setTimeout> | null = null
let coldStartRetryTimer: ReturnType<typeof setTimeout> | null = null
let bgSyncSettings: UsageBackgroundSyncSettings = DEFAULT_BG_SYNC
// Extra delay added on top of the base Claude cadence after a failed probe.
// Grows exponentially per consecutive failure, resets to 0 on success.
let claudeBackoffMs = 0

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
  // Same numbers to the phone. The bridge drops the call when nothing actually
  // moved, so the isSyncing flips this function also fires on cost nothing.
  remoteBridgeOnUsage(snapshot)
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

// Compute the next Claude backoff delay from the probe that just completed.
// A clean probe (no error) resets to 0 → next poll fires at the base cadence.
// A rate-limit / error doubles the extra delay (capped) so repeated 429s space
// the polls out instead of hammering the endpoint. Exported for testing.
export function nextClaudeBackoffMs(currentBackoffMs: number, probe: UsageProbeResult | null): number {
  if (!probe?.error) return 0
  if (currentBackoffMs <= 0) return CLAUDE_BACKOFF_START_MS
  return Math.min(currentBackoffMs * 2, CLAUDE_BACKOFF_MAX_MS)
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
      // Recompute Claude backoff from whatever the probe returned, regardless
      // of what triggered it (bg poll, hover, manual). A 429 here spaces out
      // the next background poll; a success brings it back to base cadence.
      if (providerId === 'claude') {
        claudeBackoffMs = nextClaudeBackoffMs(claudeBackoffMs, merged)
      }
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

async function runScans(): Promise<void> {
  try {
    snapshot.claude = { ...snapshot.claude, scan: await scanClaudeUsage() }
  } catch {}
  try {
    snapshot.codex = { ...snapshot.codex, scan: await scanCodexUsage() }
  } catch {}
  emit()
}

function clearBgSyncTimers(): void {
  if (codexPollTimer) {
    clearTimeout(codexPollTimer)
    codexPollTimer = null
  }
  if (claudePollTimer) {
    clearTimeout(claudePollTimer)
    claudePollTimer = null
  }
}

// Codex loop: local-file scan, fixed tight cadence, no backoff needed.
function scheduleCodexPoll(): void {
  if (codexPollTimer) { clearTimeout(codexPollTimer); codexPollTimer = null }
  if (!bgSyncSettings.enabled) return
  codexPollTimer = setTimeout(async () => {
    try {
      await probeProvider('codex')
    } finally {
      scheduleCodexPoll()
    }
  }, CODEX_POLL_INTERVAL_MS)
}

// Claude loop: network endpoint, base cadence + exponential backoff. The base
// comes from the (clamped) user interval; `claudeBackoffMs` is updated by
// probeProvider after every Claude probe.
function scheduleClaudePoll(): void {
  if (claudePollTimer) { clearTimeout(claudePollTimer); claudePollTimer = null }
  if (!bgSyncSettings.enabled) return
  const base = Math.max(MIN_BG_SYNC_SECONDS, bgSyncSettings.intervalSeconds) * 1000
  const delay = base + claudeBackoffMs
  claudePollTimer = setTimeout(async () => {
    try {
      await probeProvider('claude')
    } finally {
      scheduleClaudePoll()
    }
  }, delay)
}

function scheduleBgSync(): void {
  clearBgSyncTimers()
  scheduleCodexPoll()
  scheduleClaudePoll()
}

function applyBgSyncSettings(next: UsageBackgroundSyncSettings): void {
  bgSyncSettings = {
    enabled: !!next.enabled,
    intervalSeconds: Math.max(MIN_BG_SYNC_SECONDS, next.intervalSeconds | 0 || DEFAULT_BG_SYNC.intervalSeconds),
  }
  scheduleBgSync()
}

export function initUsageManager(window: BrowserWindow): void {
  mainWindow = window

  bgSyncSettings = loadUsageBackgroundSync() ?? DEFAULT_BG_SYNC

  ipcMain.handle('get-usage-snapshot', () => snapshot)
  ipcMain.handle('refresh-usage', async (_e, providerId?: UsageProviderId) => {
    if (providerId === 'claude' || providerId === 'codex') {
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
  scheduleBgSync()
}

export function stopUsageManager(): void {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null }
  clearBgSyncTimers()
  if (coldStartRetryTimer) { clearTimeout(coldStartRetryTimer); coldStartRetryTimer = null }
  mainWindow = null

  try { ipcMain.removeHandler('get-usage-snapshot') } catch {}
  try { ipcMain.removeHandler('refresh-usage') } catch {}
  try { ipcMain.removeHandler('get-usage-bg-sync') } catch {}
  try { ipcMain.removeHandler('set-usage-bg-sync') } catch {}
}
