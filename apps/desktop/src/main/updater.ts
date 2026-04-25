import { app, BrowserWindow, ipcMain } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'
import { isNetworkUpdaterError, summarizeUpdaterError } from '../shared/update-status-helpers'

let mainWin: BrowserWindow | null = null
let checkInterval: ReturnType<typeof setInterval> | null = null
let lastStatus: UpdateStatus | null = null
let lastReleaseMetadata: Partial<UpdateStatus> | null = null

const UPDATER_RELEASES_URL = 'https://github.com/Thiagoxp95/orchestra/releases/tag/'
const UPDATE_IPC_CHANNELS = ['check-for-update', 'install-update', 'get-update-status'] as const

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
}

function clearUpdateIpcHandlers(): void {
  for (const channel of UPDATE_IPC_CHANNELS) {
    try { ipcMain.removeHandler(channel) } catch {}
  }
}

function registerUpdateIpcHandlers(): void {
  clearUpdateIpcHandlers()

  ipcMain.handle('check-for-update', () => {
    if (!app.isPackaged) return null
    return autoUpdater.checkForUpdates()
  })

  ipcMain.handle('install-update', () => {
    if (!app.isPackaged) return false
    logUpdater('INFO', `quitAndInstall requested for ${lastReleaseMetadata?.version ?? 'unknown version'}`)
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

  return resolvedTag ? `${UPDATER_RELEASES_URL}${resolvedTag}` : undefined
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

  mainWin = win

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

export function stopUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
  clearUpdateIpcHandlers()
}
