// src/main/index.ts
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from 'electron'
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
  const { workArea } = screen.getPrimaryDisplay()
  mainWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
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

  // Intercept Cmd+W to close session, and prevent default for Cmd+T/N/O so they reach renderer
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.meta && !input.shift && !input.alt && !input.control) {
      if (input.key === 'w') {
        event.preventDefault()
        mainWindow?.webContents.send('close-active-session')
      }
    }
  })

  // Custom menu: strip Cmd+N, Cmd+O, Cmd+T accelerators so they reach the renderer
  const menu = Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ]
    },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ]
    },
  ])
  Menu.setApplicationMenu(menu)

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

ipcMain.handle('get-git-diff-files', (_, cwd: string) => {
  return new Promise<{ file: string; added: number; removed: number; status: string }[]>((resolve) => {
    execFile('git', ['diff', '--numstat', 'HEAD'], { cwd, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([])
      const files: { file: string; added: number; removed: number; status: string }[] = []
      for (const line of stdout.trim().split('\n')) {
        if (!line) continue
        const [a, r, ...rest] = line.split('\t')
        const file = rest.join('\t')
        files.push({
          file,
          added: a === '-' ? 0 : parseInt(a) || 0,
          removed: r === '-' ? 0 : parseInt(r) || 0,
          status: 'M'
        })
      }
      // Also get untracked files
      execFile('git', ['ls-files', '--others', '--exclude-standard'], { cwd, maxBuffer: 1024 * 1024 }, (err2, stdout2) => {
        if (!err2 && stdout2.trim()) {
          for (const file of stdout2.trim().split('\n')) {
            if (file) files.push({ file, added: 0, removed: 0, status: 'U' })
          }
        }
        // Get deleted files
        execFile('git', ['diff', '--name-only', '--diff-filter=D', 'HEAD'], { cwd, maxBuffer: 1024 * 1024 }, (err3, stdout3) => {
          if (!err3 && stdout3.trim()) {
            for (const file of stdout3.trim().split('\n')) {
              const existing = files.find(f => f.file === file)
              if (existing) existing.status = 'D'
            }
          }
          // Get added (new staged) files
          execFile('git', ['diff', '--name-only', '--diff-filter=A', 'HEAD'], { cwd, maxBuffer: 1024 * 1024 }, (err4, stdout4) => {
            if (!err4 && stdout4.trim()) {
              for (const file of stdout4.trim().split('\n')) {
                const existing = files.find(f => f.file === file)
                if (existing) existing.status = 'A'
              }
            }
            resolve(files)
          })
        })
      })
    })
  })
})

ipcMain.handle('get-git-file-diff', (_, cwd: string, file: string) => {
  return new Promise<string>((resolve) => {
    // Try tracked file diff first
    execFile('git', ['diff', 'HEAD', '--', file], { cwd, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        // Maybe untracked — just read the file content and format as "all added"
        execFile('git', ['show', `HEAD:${file}`], { cwd, maxBuffer: 5 * 1024 * 1024 }, (err2, oldContent) => {
          if (!err && stdout.trim()) {
            resolve(stdout)
          } else {
            // Truly new file — read from disk
            const filePath = require('path').join(cwd, file)
            try {
              const content = require('fs').readFileSync(filePath, 'utf-8')
              // Format as unified diff
              const lines = content.split('\n').map((l: string) => `+${l}`).join('\n')
              resolve(`--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${content.split('\n').length} @@\n${lines}`)
            } catch {
              resolve('')
            }
          }
        })
        return
      }
      resolve(stdout)
    })
  })
})

ipcMain.handle('run-background-command', (_, cwd: string, command: string) => {
  return new Promise<{ success: boolean; error?: string }>((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    execFile(shell, ['-l', '-c', command], { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 300000 }, (err, _stdout, stderr) => {
      if (err) return resolve({ success: false, error: stderr || err.message })
      resolve({ success: true })
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

ipcMain.handle('get-listening-ports', async () => {
  try {
    const client = getDaemonClient()
    const sessions = await client.listSessions()
    const alivePids = sessions.filter((s) => s.isAlive && s.pid).map((s) => s.pid!)

    if (alivePids.length === 0) return []

    return new Promise<{ port: number; pid: number; sessionId: string }[]>((resolve) => {
      // Find all listening TCP ports for descendant processes
      execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-nP', '-Fn'], (error, stdout) => {
        if (error || !stdout) { resolve([]); return }

        // Parse lsof output: lines starting with p=pid, n=name (contains :port)
        const results: { port: number; pid: number; sessionId: string }[] = []
        let currentPid = 0
        for (const line of stdout.split('\n')) {
          if (line.startsWith('p')) {
            currentPid = parseInt(line.slice(1), 10)
          } else if (line.startsWith('n') && currentPid) {
            const match = line.match(/:(\d+)$/)
            if (match) {
              const port = parseInt(match[1], 10)
              // Find which session owns this pid (check process tree)
              const session = sessions.find((s) => s.pid === currentPid)
              if (session) {
                results.push({ port, pid: currentPid, sessionId: session.sessionId })
              }
            }
          }
        }

        // Also check child processes of session PIDs
        execFile('ps', ['-eo', 'pid,ppid'], (err2, psOut) => {
          if (err2 || !psOut) { resolve(results); return }

          // Build parent->children map
          const parentMap = new Map<number, number>()
          for (const line of psOut.split('\n')) {
            const parts = line.trim().split(/\s+/)
            if (parts.length === 2) {
              const pid = parseInt(parts[0], 10)
              const ppid = parseInt(parts[1], 10)
              if (!isNaN(pid) && !isNaN(ppid)) parentMap.set(pid, ppid)
            }
          }

          // For each lsof port, walk up the tree to find if it belongs to a session
          const allPorts = new Set(results.map((r) => r.port))
          let currentLsofPid = 0
          for (const line of stdout.split('\n')) {
            if (line.startsWith('p')) {
              currentLsofPid = parseInt(line.slice(1), 10)
            } else if (line.startsWith('n') && currentLsofPid) {
              const match = line.match(/:(\d+)$/)
              if (match) {
                const port = parseInt(match[1], 10)
                if (allPorts.has(port)) continue // already found

                // Walk up process tree
                let pid = currentLsofPid
                for (let i = 0; i < 20; i++) {
                  const parent = parentMap.get(pid)
                  if (!parent) break
                  const session = sessions.find((s) => s.pid === parent)
                  if (session) {
                    results.push({ port, pid: currentLsofPid, sessionId: session.sessionId })
                    break
                  }
                  pid = parent
                }
              }
            }
          }

          // Deduplicate by port
          const seen = new Set<number>()
          resolve(results.filter((r) => {
            if (seen.has(r.port)) return false
            seen.add(r.port)
            return true
          }))
        })
      })
    })
  } catch {
    return []
  }
})

// App lifecycle
app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  app.quit()
})
