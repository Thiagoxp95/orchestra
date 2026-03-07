// src/main/index.ts
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { getDaemonClient } from './daemon-client'
import { startMonitoring, stopMonitoring } from './process-monitor'
import { loadPersistedData, saveWorkspaces } from './persistence'

let mainWindow: BrowserWindow | null = null

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Connect to daemon
  const client = getDaemonClient()
  try {
    await client.connect(mainWindow)
  } catch (err) {
    console.error('[main] Failed to connect to daemon:', err)
  }

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  startMonitoring(mainWindow, client)

  mainWindow.on('close', () => {
    stopMonitoring()
    // Just disconnect — daemon keeps running
    client.disconnect()
  })
}

// IPC Handlers
ipcMain.on('terminal-create', async (_, sessionId, opts) => {
  const client = getDaemonClient()
  const result = await client.createOrAttach(sessionId, {
    cwd: opts.cwd,
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    initialCommand: opts.initialCommand
  })

  // If reattaching, send snapshot to renderer
  if (result.snapshot && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal-snapshot', sessionId, result.snapshot)
  }
})

ipcMain.on('terminal-write', (_, sessionId, data) => {
  getDaemonClient().write(sessionId, data)
})

ipcMain.on('terminal-resize', (_, sessionId, cols, rows) => {
  getDaemonClient().resize(sessionId, cols, rows).catch(() => {})
})

ipcMain.on('terminal-kill', (_, sessionId) => {
  getDaemonClient().kill(sessionId).catch(() => {})
})

ipcMain.on('save-state', (_, data) => {
  saveWorkspaces(data.workspaces, data.sessions, data.activeWorkspaceId, data.activeSessionId, data.settings)
})

ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('get-persisted-data', () => {
  return loadPersistedData()
})

ipcMain.handle('list-daemon-sessions', async () => {
  return getDaemonClient().listSessions()
})

// App lifecycle
app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  app.quit()
})
