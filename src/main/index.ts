// src/main/index.ts
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import * as fs from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { is } from '@electron-toolkit/utils'
import { getDaemonClient } from './daemon-client'
import { startMonitoring, stopMonitoring } from './process-monitor'
import { loadPersistedData, saveWorkspaces } from './persistence'
import { SNAPSHOTS_DIR } from '../daemon/protocol'
import { HistoryWriter } from '../daemon/history-writer'

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

  // Intercept Cmd+W to close active session instead of window
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.meta && !input.shift && !input.alt && !input.control) {
      if (input.key === 'w') {
        event.preventDefault()
        mainWindow?.webContents.send('close-active-session')
      }
      if (input.key === 't') {
        event.preventDefault()
      }
      // Intercept Cmd+1..9 for workspace switching
      if (input.key >= '1' && input.key <= '9') {
        event.preventDefault()
      }
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

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (result.snapshot && !result.isNew) {
      // Hot restore: daemon had the session alive (not a fresh spawn after reboot)
      mainWindow.webContents.send('terminal-snapshot', sessionId, result.snapshot)
    } else if (result.isNew) {
      // Cold restore: try JSON snapshot first, then fall back to history file
      let restored = false
      try {
        const snapshotPath = `${SNAPSHOTS_DIR}/${sessionId}.json`
        if (fs.existsSync(snapshotPath)) {
          const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
          mainWindow.webContents.send('terminal-snapshot', sessionId, snapshot)
          fs.unlinkSync(snapshotPath)
          restored = true
        }
      } catch {}

      // Fall back to append-only history file (survives hard kills / reboots)
      if (!restored) {
        try {
          const history = HistoryWriter.readForRestore(sessionId)
          if (history) {
            mainWindow.webContents.send('terminal-snapshot', sessionId, {
              snapshotAnsi: history.data,
              rehydrateSequences: '',
              cwd: history.meta.cwd || opts.cwd,
              cols: history.meta.cols || opts.cols || 80,
              rows: history.meta.rows || opts.rows || 24
            })
            // Clean up consumed history
            HistoryWriter.cleanupSession(sessionId)
          }
        } catch {}
      }
    }
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

ipcMain.handle('get-git-branch', (_, cwd: string) => {
  return new Promise<string | null>((resolve) => {
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }, (err, stdout) => {
      if (err) return resolve(null)
      resolve(stdout.trim() || null)
    })
  })
})

ipcMain.handle('get-git-diff-stat', (_, cwd: string) => {
  return new Promise<{ added: number; removed: number } | null>((resolve) => {
    execFile('git', ['diff', '--numstat', 'HEAD'], { cwd, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null)
      let added = 0, removed = 0
      for (const line of stdout.trim().split('\n')) {
        if (!line) continue
        const [a, r] = line.split('\t')
        if (a !== '-') added += parseInt(a) || 0
        if (r !== '-') removed += parseInt(r) || 0
      }
      resolve({ added, removed })
    })
  })
})

ipcMain.handle('create-worktree', (_, repoDir: string, branch: string, worktreesDir: string) => {
  const base = worktreesDir || join(homedir(), '.orchestra', 'worktrees')
  const repoName = repoDir.split('/').pop() || 'repo'
  const targetDir = join(base, repoName, branch)

  return new Promise<{ success: boolean; path?: string; error?: string }>((resolve) => {
    // Ensure target parent directory exists
    fs.mkdirSync(join(base, repoName), { recursive: true })

    execFile('git', ['worktree', 'add', '-b', branch, targetDir], { cwd: repoDir }, (err, _stdout, stderr) => {
      if (err) {
        // Try without -b (branch already exists)
        execFile('git', ['worktree', 'add', targetDir, branch], { cwd: repoDir }, (err2, _stdout2, stderr2) => {
          if (err2) return resolve({ success: false, error: stderr2 || stderr || err2.message })
          resolve({ success: true, path: targetDir })
        })
        return
      }
      resolve({ success: true, path: targetDir })
    })
  })
})

ipcMain.handle('list-daemon-sessions', async () => {
  return getDaemonClient().listSessions()
})

// App lifecycle
app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  app.quit()
})
