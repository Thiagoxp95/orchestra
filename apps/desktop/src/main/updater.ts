import { app, BrowserWindow, ipcMain } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'
import { isNetworkUpdaterError, summarizeUpdaterError } from '../shared/update-status-helpers'
import {
  buildMirroredUpdate,
  planRestartToUpdate,
  type MirroredUpdate,
  type RestartUpdatePlan,
} from './remote-bridge-update'

let mainWin: BrowserWindow | null = null
let checkInterval: ReturnType<typeof setInterval> | null = null
let lastStatus: UpdateStatus | null = null
let lastReleaseMetadata: Partial<UpdateStatus> | null = null

// The version staged on disk. Tracked apart from lastStatus because status is
// transient: the 30-minute background check flips it to 'checking' while the
// downloaded artifact is still sitting there waiting for a restart, and a remote
// "restart & install" must not read that as "nothing to install".
let downloadedVersion: string | null = null

// Latched once a restart-to-update has been accepted. This is the idempotency
// guard for the remote command: pendingCommands is a full-snapshot subscription
// and the user can tap twice, so the same intent legitimately arrives more than
// once — a second quitAndInstall() while the first is tearing the app down is
// the double-restart we must never perform.
let restartPending = false

// Notified whenever the mirrored update verdict may have moved, so the remote
// bridge can push it to the phone within a frame instead of on its next
// heartbeat. A listener rather than a direct import: updater.ts must not depend
// on remote-bridge.ts, which already depends on this module.
let statusListener: (() => void) | null = null

/** Delay between accepting a remote restart and actually quitting, so the
 *  command's ack (and the final "restarting" state push) reach the phone before
 *  the process dies. */
const REMOTE_RESTART_GRACE_MS = 1500

const UPDATE_IPC_CHANNELS = ['check-for-update', 'install-update', 'get-update-status'] as const
const MISSING_UPDATER_CONFIG_MESSAGE = 'Update metadata is not available for this build.'

// Optional, baked in at build time from a CI secret (fine-grained PAT,
// contents: read). Only a PRIVATE fork needs it: electron-updater must then use
// the authenticated GitHub API, since the public releases.atom feed 404s for
// private repos. Empty in dev/unsigned builds and for public repos.
const UPDATER_GH_TOKEN = (import.meta.env.MAIN_VITE_UPDATER_GH_TOKEN ?? '').trim()

/**
 * The GitHub repo this build updates from. electron-builder writes it into the
 * packaged app-update.yml from the `publish` config (which resolves to the
 * repo the build was cut from), so a fork updates from its own releases with
 * no code change.
 */
function readUpdaterRepo(): { owner: string; repo: string } | null {
  const configPath = getPackagedUpdaterConfigPath()
  if (!configPath || !existsSync(configPath)) return null
  try {
    const text = readFileSync(configPath, 'utf8')
    const owner = /^owner:\s*['"]?([^'"\n]+)['"]?\s*$/m.exec(text)?.[1].trim()
    const repo = /^repo:\s*['"]?([^'"\n]+)['"]?\s*$/m.exec(text)?.[1].trim()
    return owner && repo ? { owner, repo } : null
  } catch {
    return null
  }
}

function configurePrivateFeed(): void {
  if (!UPDATER_GH_TOKEN) return
  const target = readUpdaterRepo()
  if (!target) {
    logUpdater('WARN', 'Updater token is set but app-update.yml names no owner/repo; using the default feed')
    return
  }
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: target.owner,
    repo: target.repo,
    private: true,
    token: UPDATER_GH_TOKEN,
  })
  logUpdater('INFO', 'Configured authenticated GitHub feed for private-repo updates')
}

function getPackagedUpdaterConfigPath(): string | null {
  const resourcesPath = process.resourcesPath
  return resourcesPath ? join(resourcesPath, 'app-update.yml') : null
}

function canUseUpdater(): boolean {
  if (!app.isPackaged) return false

  const configPath = getPackagedUpdaterConfigPath()
  return !!configPath && existsSync(configPath)
}

function getUpdaterLogPath(): string {
  const logDir = join(app.getPath('userData'), 'logs')
  mkdirSync(logDir, { recursive: true })
  return join(logDir, 'updater.log')
}

function logUpdater(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string, detail?: unknown): void {
  const suffix = detail === undefined
    ? ''
    : typeof detail === 'string'
      ? ` ${detail}`
      : ` ${JSON.stringify(detail)}`

  try {
    appendFileSync(getUpdaterLogPath(), `[${new Date().toISOString()}] ${level} ${message}${suffix}\n`)
  } catch {
    // Best-effort logging only.
  }

  if (level === 'ERROR') {
    console.error('[updater]', message, detail ?? '')
  } else if (level === 'WARN') {
    console.warn('[updater]', message, detail ?? '')
  } else if (level === 'DEBUG') {
    console.debug('[updater]', message, detail ?? '')
  } else {
    console.info('[updater]', message, detail ?? '')
  }
}

function send(status: UpdateStatus): void {
  lastStatus = status
  mainWin?.webContents.send('update-status', status)
  notifyStatusListener()
}

function notifyStatusListener(): void {
  try {
    statusListener?.()
  } catch (err) {
    logUpdater('WARN', 'update status listener threw', String(err))
  }
}

/**
 * Subscribe to update-state changes (the remote bridge does, so the phone's
 * button follows the desktop within a frame). Single listener by design — there
 * is exactly one mirror. Pass null to unsubscribe.
 */
export function setUpdateStatusListener(listener: (() => void) | null): void {
  statusListener = listener
}

/**
 * The update verdict as the web mirror carries it. Read fresh on every state
 * push (rather than cached in the bridge) so a payload-less push can never
 * republish a stale copy.
 */
export function getMirroredUpdate(): MirroredUpdate {
  return buildMirroredUpdate({
    status: lastStatus,
    downloadedVersion,
    currentVersion: app.getVersion(),
    supported: canUseUpdater(),
    restartPending,
  })
}

export interface RestartToUpdateResult {
  action: RestartUpdatePlan['action']
  reason?: string
  /** The version this restart installs, when one is staged. */
  version?: string
}

/**
 * Handle a remote "restart & install the pending update" request.
 *
 * Idempotent: the first accepted call latches restartPending, and every later
 * one is a no-op that reports 'already-restarting'. With no update staged it
 * kicks a check instead of failing silently — the resulting status events flow
 * back through the mirror, so the phone learns whether there was anything to
 * install.
 */
export function requestRestartToUpdate(
  graceMs: number = REMOTE_RESTART_GRACE_MS,
): RestartToUpdateResult {
  const plan = planRestartToUpdate({
    supported: canUseUpdater(),
    downloaded: downloadedVersion !== null,
    restartPending,
  })

  if (plan.action === 'none') {
    logUpdater('INFO', `Remote restart-to-update ignored: ${plan.reason}`)
    return { action: 'none', reason: plan.reason }
  }

  if (plan.action === 'check') {
    logUpdater('INFO', 'Remote restart-to-update with nothing staged — checking for updates')
    void autoUpdater.checkForUpdates().catch((err: unknown) => {
      logUpdater('WARN', 'Remote-triggered update check failed', String(err))
    })
    return { action: 'check', reason: plan.reason }
  }

  restartPending = true
  const version = downloadedVersion ?? undefined
  logUpdater('INFO', `Remote restart-to-update accepted for ${version ?? 'unknown version'}`)
  // Tell the mirror we're going down BEFORE quitting, and leave a grace window
  // so that push (and the command's ack) actually land — an unacked command
  // would still be pending when the newly installed app comes back up.
  notifyStatusListener()
  setTimeout(() => {
    try {
      autoUpdater.quitAndInstall()
    } catch (err) {
      logUpdater('ERROR', 'quitAndInstall failed', String(err))
      restartPending = false
      notifyStatusListener()
    }
  }, graceMs)
  return { action: 'install', version }
}

function clearUpdateIpcHandlers(): void {
  for (const channel of UPDATE_IPC_CHANNELS) {
    try { ipcMain.removeHandler(channel) } catch {}
  }
}

function registerUpdateIpcHandlers(): void {
  clearUpdateIpcHandlers()

  ipcMain.handle('check-for-update', () => {
    if (!canUseUpdater()) {
      logUpdater('WARN', MISSING_UPDATER_CONFIG_MESSAGE)
      return null
    }
    return autoUpdater.checkForUpdates()
  })

  ipcMain.handle('install-update', () => {
    if (!canUseUpdater()) return false
    if (restartPending) {
      logUpdater('INFO', 'quitAndInstall already in flight — ignoring duplicate install request')
      return true
    }
    restartPending = true
    logUpdater('INFO', `quitAndInstall requested for ${lastReleaseMetadata?.version ?? 'unknown version'}`)
    // Let the mirror show "restarting" on the phone too — the desktop button and
    // the remote one drive the same single restart.
    notifyStatusListener()
    autoUpdater.quitAndInstall()
    return true
  })

  // Allow renderer to request the last known update status on mount,
  // in case the initial check completed before the listener was ready.
  ipcMain.handle('get-update-status', () => lastStatus)
}

function normalizeReleaseNotes(notes: unknown): string | undefined {
  if (!notes) return undefined
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes.map((n: any) => n.note ?? '').filter(Boolean).join('\n')
  }
  return undefined
}

function buildReleaseUrl(version: string | undefined, tag: unknown): string | undefined {
  const resolvedTag = typeof tag === 'string' && tag
    ? tag
    : version
      ? `v${version}`
      : undefined

  const target = readUpdaterRepo()
  return resolvedTag && target
    ? `https://github.com/${target.owner}/${target.repo}/releases/tag/${resolvedTag}`
    : undefined
}

function extractReleaseMetadata(info: any): Partial<UpdateStatus> {
  return {
    version: info?.version,
    currentVersion: app.getVersion(),
    releaseName: typeof info?.releaseName === 'string' ? info.releaseName : undefined,
    releaseNotes: normalizeReleaseNotes(info?.releaseNotes),
    releaseDate: typeof info?.releaseDate === 'string' ? info.releaseDate : undefined,
    releaseUrl: buildReleaseUrl(info?.version, info?.tag),
  }
}

export function initUpdater(win: BrowserWindow | null): void {
  registerUpdateIpcHandlers()

  if (!app.isPackaged || !win) return

  if (!canUseUpdater()) {
    logUpdater('WARN', MISSING_UPDATER_CONFIG_MESSAGE, getPackagedUpdaterConfigPath() ?? 'unknown app-update.yml path')
    return
  }

  mainWin = win

  // Private fork with a token: point the updater at the authenticated GitHub
  // API. Must run before the first checkForUpdates() so version discovery uses
  // the API path instead of the public releases.atom feed.
  configurePrivateFeed()

  // Auto-download: once an update is available, fetch it silently in the background.
  // The sidebar card only appears when status is 'downloaded' (or on a real error),
  // so the user sees a single "Restart & update" action — no intermediate Download click.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = {
    info: (message: unknown) => logUpdater('INFO', String(message)),
    warn: (message: unknown) => logUpdater('WARN', String(message)),
    error: (message: unknown) => logUpdater('ERROR', String(message)),
    debug: (message: unknown) => logUpdater('DEBUG', String(message)),
  } as typeof autoUpdater.logger

  logUpdater('INFO', `Initialized updater for Orchestra ${app.getVersion()}`)

  autoUpdater.on('checking-for-update', () => {
    logUpdater('INFO', 'Checking for updates')
    send({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    lastReleaseMetadata = extractReleaseMetadata(info)
    logUpdater('INFO', `Update available (auto-downloading): ${lastReleaseMetadata.version ?? 'unknown version'}`, lastReleaseMetadata)
    send({
      status: 'available',
      ...lastReleaseMetadata,
    })
  })

  autoUpdater.on('update-not-available', () => {
    logUpdater('INFO', 'No update available')
    send({ status: 'not-available' })
  })

  autoUpdater.on('download-progress', (progress) => {
    send({
      status: 'downloading',
      percent: Math.round(progress.percent),
      ...lastReleaseMetadata,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    lastReleaseMetadata = {
      ...lastReleaseMetadata,
      ...extractReleaseMetadata(info),
    }
    // Staged on disk from here until a restart consumes it. Survives the later
    // 'checking'/'not-available' events a background re-check emits, which is
    // what makes a remote restart still find something to install.
    downloadedVersion = lastReleaseMetadata.version ?? 'unknown'
    logUpdater('INFO', `Update downloaded: ${lastReleaseMetadata.version ?? 'unknown version'}`)
    send({
      status: 'downloaded',
      ...lastReleaseMetadata,
    })
  })

  autoUpdater.on('error', (err) => {
    const rawMessage = err?.message ?? 'Update error'

    // Network/offline failures are expected background noise (e.g. no wifi during a
    // scheduled check). Log them but keep the sidebar silent — the next 30-minute
    // check will retry automatically. Real errors (checksum, signing, etc.) still
    // surface to the user with a Retry button.
    if (isNetworkUpdaterError(rawMessage)) {
      logUpdater('WARN', `Suppressed network error during update check: ${rawMessage}`)
      return
    }

    logUpdater('ERROR', rawMessage, err?.stack ?? rawMessage)
    send({
      status: 'error',
      message: summarizeUpdaterError(rawMessage),
      detail: rawMessage,
      ...lastReleaseMetadata,
    })
  })

  // Defer the initial check until the renderer has finished loading so the
  // update-status event isn't lost before the Sidebar mounts its listener.
  win.webContents.once('did-finish-load', () => {
    // Small delay to ensure React has mounted and registered listeners
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {})
    }, 2000)
  })

  checkInterval = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 30 * 60 * 1000)
}

/** Test seam — the module is a singleton and its latches (restartPending,
 *  downloadedVersion) would otherwise leak between cases. */
export function resetUpdaterState(): void {
  lastStatus = null
  lastReleaseMetadata = null
  downloadedVersion = null
  restartPending = false
  statusListener = null
  mainWin = null
}

export function stopUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
  clearUpdateIpcHandlers()
}
