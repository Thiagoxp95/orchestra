import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

let mainWin: BrowserWindow | null = null
let checkInterval: ReturnType<typeof setInterval> | null = null
let lastStatus: UpdateStatus | null = null

function send(status: UpdateStatus): void {
  lastStatus = status
  mainWin?.webContents.send('update-status', status)
}

function normalizeReleaseNotes(notes: unknown): string | undefined {
  if (!notes) return undefined
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes.map((n: any) => n.note ?? '').filter(Boolean).join('\n')
  }
  return undefined
}

export function initUpdater(win: BrowserWindow | null): void {
  if (!app.isPackaged || !win) return

  mainWin = win

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => {
    send({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    send({
      status: 'available',
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    })
  })

  autoUpdater.on('update-not-available', () => {
    send({ status: 'not-available' })
  })

  autoUpdater.on('download-progress', (progress) => {
    send({ status: 'downloading', percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    send({ status: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    console.warn('[updater]', err?.message ?? 'Update error')
    send({ status: 'error', message: err?.message ?? 'Update error' })
  })

  // IPC handlers
  ipcMain.handle('check-for-update', () => autoUpdater.checkForUpdates())
  ipcMain.handle('download-update', () => autoUpdater.downloadUpdate())
  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall()
  })

  // Allow renderer to request the last known update status on mount,
  // in case the initial check completed before the listener was ready.
  ipcMain.handle('get-update-status', () => lastStatus)

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
}
