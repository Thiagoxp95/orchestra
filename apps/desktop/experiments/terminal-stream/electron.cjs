// A separate Electron viewer for the lab. Does not load Orchestra's application,
// preload, credentials or user data. Start the lab server first.
const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const directory = mkdtempSync(join(tmpdir(), 'orchestra-terminal-electron-prototype-'))
app.setPath('userData', directory)
app.setName('Orchestra Terminal Lab')
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1450, height: 960, backgroundColor: '#111315',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  void window.loadURL(`http://127.0.0.1:${Number(process.env.ORCHESTRA_LAB_PORT ?? 4381)}`)
})
app.on('window-all-closed', () => app.quit())
app.on('quit', () => rmSync(directory, { recursive: true, force: true }))
