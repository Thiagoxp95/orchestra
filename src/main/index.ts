// src/main/index.ts
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { is } from '@electron-toolkit/utils'
import { createPty, writePty, resizePty, killPty, getPtyPid, killAll } from './pty-manager'
import { startMonitoring, stopMonitoring } from './process-monitor'
import { loadPersistedData, saveWorkspaces } from './persistence'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
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

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  startMonitoring(mainWindow)
}

// IPC Handlers
ipcMain.on('terminal-create', (_, sessionId, opts) => {
  if (mainWindow) createPty(sessionId, opts, mainWindow)
})

ipcMain.on('terminal-write', (_, sessionId, data) => {
  writePty(sessionId, data)
})

ipcMain.on('terminal-resize', (_, sessionId, cols, rows) => {
  resizePty(sessionId, cols, rows)
})

ipcMain.on('terminal-kill', (_, sessionId) => {
  killPty(sessionId)
})

ipcMain.on('save-state', (_, data) => {
  saveWorkspaces(data.workspaces, data.sessions, data.activeWorkspaceId, data.activeSessionId)
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

ipcMain.handle('terminal-get-cwd', (_, sessionId) => {
  const pid = getPtyPid(sessionId)
  if (!pid) return null
  return new Promise<string | null>((resolve) => {
    execFile('lsof', ['-p', String(pid), '-Fn'], (error, stdout) => {
      if (error) { resolve(null); return }
      const match = stdout.match(/n(\/[^\n]+)/)
      resolve(match ? match[1] : null)
    })
  })
})

// App lifecycle
app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  stopMonitoring()
  killAll()
  app.quit()
})

app.on('before-quit', () => {
  stopMonitoring()
  killAll()
})
