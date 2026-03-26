// src/main/index.ts
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from 'electron'
import { join } from 'node:path'
import * as fs from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { is } from '@electron-toolkit/utils'
import { getDaemonClient } from './daemon-client'
import { registerAgentSessionAlias } from './agent-session-aliases'
import { listLiveSessionStatuses, startMonitoring, stopMonitoring } from './process-monitor'
import { initClaudeWatcher, watchSession, unwatchSession, stopAllWatchers, getClaudeWatcherDebugState, markClaudeSessionStarted, hintInterrupt as hintClaudeInterrupt, setAgentSessionRegistryRef as setClaudeRegistryRef } from './claude-session-watcher'
import { initCodexWatcher, watchCodexSession, unwatchCodexSession, stopAllCodexWatchers, getCodexWatcherDebugState, markCodexSessionStarted, setAgentSessionRegistryRef as setCodexRegistryRef } from './codex-session-watcher'
import { initTerminalOutputBuffer, stopTerminalOutputBuffer } from './terminal-output-buffer'
import { initIdleNotifier, setActiveSessionId, setOnRequiresUserInput } from './idle-notifier'
import { getClaudeHookPort, startClaudeHookServer, stopClaudeHookServer } from './claude-hook-server'
import { initUpdater, stopUpdater } from './updater'
import { loadPersistedData, saveWorkspaces, loadAutomationRuns, saveAutomationRun } from './persistence'
import {
  initAutomationScheduler,
  stopAutomationScheduler,
  runAutomationNow,
  cancelAutomation,
  onActionDeleted,
  getPersistentAutomations,
  getSchedulerDebugState,
  recomputeAllSchedules,
} from './automation-scheduler'
import {
  startWebhookListener,
  stopWebhookListener,
  ensureWebhookListenerRunning,
  refreshWebhookListener,
  createWebhook,
  deleteWebhook,
  updateWebhookFilter,
} from './webhook-listener'
import { SNAPSHOTS_DIR } from '../daemon/protocol'
import { HistoryWriter } from '../daemon/history-writer'
import { scanSkills, getSkillContent } from './skill-scanner'
import type { RepositoryWorkspaceSettings } from '../shared/types'
import {
  loadRepositoryWorkspaceSettings,
  mergeRepositorySettingsIntoPersistedData,
  saveRepositoryWorkspaceSettings,
  syncRepositoryWorkspaceSettings,
} from './workspace-repository-settings'
import { getWorkStateDebugSnapshot } from './work-state-debug'
import { AgentSessionRegistry } from './agent-session-authority'
import { showInterruptionPopup, closeInterruptionPopup, closeAllInterruptionPopups } from './interruption-popup'
import { CodexAppServerManager } from './codex-app-server-manager'
import { initUsageManager, stopUsageManager } from './usage-manager'
import { registerLinearSafeStorage } from './linear-safe-storage'

let mainWindow: BrowserWindow | null = null
let agentSessionRegistry: AgentSessionRegistry | null = null
let codexAppServerManager: CodexAppServerManager | null = null
const hasSingleInstanceLock = is.dev || app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()
  })
}

function hasTerminalSnapshotContent(snapshot: {
  snapshotAnsi?: string
  rehydrateSequences?: string
} | null | undefined): boolean {
  return Boolean(snapshot?.snapshotAnsi || snapshot?.rehydrateSequences)
}

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
  await startClaudeHookServer()
  initClaudeWatcher(mainWindow)
  initCodexWatcher(mainWindow)
  agentSessionRegistry = new AgentSessionRegistry((sessionId, status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-session-state', status)
    }

    // Interruption mode: close popup when agent goes back to working
    if (status.state === 'working' || status.state === 'unknown') {
      closeInterruptionPopup(sessionId)
    }
  })
  setClaudeRegistryRef(agentSessionRegistry)
  setCodexRegistryRef(agentSessionRegistry)
  codexAppServerManager = new CodexAppServerManager(agentSessionRegistry)
  codexAppServerManager.start().catch((err) => {
    console.warn('[codex-app-server-manager] failed to start:', err)
  })
  initTerminalOutputBuffer(mainWindow)
  initIdleNotifier(mainWindow)
  setOnRequiresUserInput((sessionId, _agentType) => {
    const persisted = loadPersistedData()
    // Find which workspace owns this session
    let workspace: import('../shared/types').Workspace | null = null
    for (const ws of Object.values(persisted.workspaces)) {
      for (const tree of ws.trees) {
        if (tree.sessionIds.includes(sessionId)) {
          workspace = ws
          break
        }
      }
      if (workspace) break
    }
    if (!workspace || !workspace.interruptionMode) return

    const session = persisted.sessions[sessionId]
    const sessionLabel = session?.label ?? 'Terminal'

    showInterruptionPopup(
      sessionId,
      workspace.id,
      workspace.name,
      workspace.color,
      sessionLabel,
      workspace.interruptionPosition,
    )
  })
  initAutomationScheduler(mainWindow)
  startWebhookListener(mainWindow)
  initUpdater(mainWindow)
  initUsageManager(mainWindow)

  // Reclaim automation runs from daemon (if it ran automations while app was closed)
  try {
    const reclaimResult = await client.sendRequest({
      type: 'automation-reclaim' as any,
    })
    if (reclaimResult?.ok && (reclaimResult as any).runs?.length > 0) {
      for (const run of (reclaimResult as any).runs) {
        saveAutomationRun(run)
      }
    }
  } catch {}

  let isQuitting = false
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    isQuitting = true

    const persistentAutomations = getPersistentAutomations()
    const handoffPromise = persistentAutomations.length > 0
      ? client.sendRequest({
          type: 'automation-handoff' as any,
          automations: persistentAutomations,
        }).catch(() => {})
      : Promise.resolve()

    handoffPromise.then(() => {
      stopWebhookListener()
      stopAutomationScheduler()
      stopMonitoring()
      stopClaudeHookServer()
      stopAllWatchers()
      if (codexAppServerManager) {
        codexAppServerManager.stop()
        codexAppServerManager = null
      }
      stopAllCodexWatchers()
      stopTerminalOutputBuffer()
      stopUsageManager()
      client.disconnect()
      mainWindow?.destroy()
    })
  })
}

export function getAgentSessionRegistry(): AgentSessionRegistry | null {
  return agentSessionRegistry
}

// IPC Handlers
ipcMain.handle('terminal-create', async (_, sessionId, opts) => {
  const client = getDaemonClient()
  const hookPort = getClaudeHookPort()

  const createOpts = {
    cwd: opts.cwd,
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    env: hookPort != null ? { ORCHESTRA_HOOK_PORT: String(hookPort) } : undefined,
    initialCommand: opts.initialCommand,
    launchProfile: opts.launchProfile
  }

  let result: { isNew: boolean; snapshot: any; pid: number | null; processSessionId: string }
  try {
    result = await client.createOrAttach(sessionId, createOpts)
  } catch (err) {
    // Connection broken — reconnect and retry once
    console.warn(`[main] terminal-create failed, retrying after reconnect:`, (err as Error).message)
    try {
      await client.reconnect()
      result = await client.createOrAttach(sessionId, createOpts)
    } catch (retryErr) {
      console.error(`[main] terminal-create retry failed:`, (retryErr as Error).message)
      return { success: false, error: (retryErr as Error).message }
    }
  }

  registerAgentSessionAlias(sessionId, result.processSessionId)

  let restoredSnapshot = false
  if (mainWindow && !mainWindow.isDestroyed()) {
    let restoredFromLiveSnapshot = false

    if (hasTerminalSnapshotContent(result.snapshot)) {
      mainWindow.webContents.send('terminal-snapshot', sessionId, result.snapshot)
      restoredFromLiveSnapshot = true
      restoredSnapshot = true
    }

    if (result.isNew && !restoredFromLiveSnapshot) {
      let restored = false
      try {
        const snapshotPath = `${SNAPSHOTS_DIR}/${sessionId}.json`
        if (fs.existsSync(snapshotPath)) {
          const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
          mainWindow.webContents.send('terminal-snapshot', sessionId, snapshot)
          fs.unlinkSync(snapshotPath)
          restored = true
          restoredSnapshot = true
        }
      } catch {}

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
            HistoryWriter.cleanupSession(sessionId)
            restoredSnapshot = true
          }
        } catch {}
      }
    }
  }

  return { success: true, restoredSnapshot }
})

ipcMain.on('terminal-prewarm', (_, opts: { cwd: string; cols?: number; rows?: number }) => {
  const hookPort = getClaudeHookPort()
  getDaemonClient().prewarmShell({
    cwd: opts.cwd,
    cols: opts.cols || 120,
    rows: opts.rows || 30,
    env: hookPort != null ? { ORCHESTRA_HOOK_PORT: String(hookPort) } : undefined,
  }).catch(() => {})
})

ipcMain.on('terminal-write', (_, sessionId, data, source = 'user') => {
  getDaemonClient().write(sessionId, data, source)
})

ipcMain.on('terminal-resize', (_, sessionId, cols, rows) => {
  getDaemonClient().resize(sessionId, cols, rows).catch(() => {})
})

ipcMain.on('show-emoji-panel', () => {
  app.showEmojiPanel()
})

ipcMain.on('terminal-kill', (_, sessionId) => {
  getDaemonClient().kill(sessionId).catch(() => {})
})

ipcMain.handle('terminal-snapshot-request', async (_, sessionId: string, cols?: number, rows?: number) => {
  try {
    if (typeof cols === 'number' && typeof rows === 'number') {
      await getDaemonClient().resize(sessionId, cols, rows)
    }
    return await getDaemonClient().getSnapshot(sessionId)
  } catch {
    return null
  }
})

ipcMain.on('claude-watch-session', (_, sessionId: string, cwd: string, claudePid?: number) => {
  watchSession(sessionId, cwd, claudePid)
})

ipcMain.on('claude-unwatch-session', (_, sessionId: string) => {
  unwatchSession(sessionId)
})

ipcMain.on('claude-session-started', (_, sessionId: string) => {
  markClaudeSessionStarted(sessionId)
})

ipcMain.on('claude-interrupt-hint', (_, sessionId: string) => {
  hintClaudeInterrupt(sessionId)
})

ipcMain.on('codex-watch-session', (_, sessionId: string, cwd: string, codexPid?: number) => {
  watchCodexSession(sessionId, cwd, codexPid)
})

ipcMain.on('codex-unwatch-session', (_, sessionId: string) => {
  unwatchCodexSession(sessionId)
})

ipcMain.on('codex-session-started', (_, sessionId: string) => {
  markCodexSessionStarted(sessionId)
})

ipcMain.handle('get-codex-debug-state', () => {
  return getCodexWatcherDebugState()
})

ipcMain.handle('get-claude-debug-state', () => {
  return getClaudeWatcherDebugState()
})

ipcMain.handle('get-work-state-debug-snapshot', (_event, lineCount?: number) => {
  return getWorkStateDebugSnapshot(lineCount)
})

ipcMain.handle('get-sessions-memory', async () => {
  try {
    const client = getDaemonClient()
    const sessions = await client.listSessions()
    const alive = sessions.filter((s) => s.isAlive && s.pid)
    if (alive.length === 0) return {}

    return new Promise<Record<string, number>>((resolve) => {
      execFile('ps', ['-eo', 'pid,ppid,rss'], (error, stdout) => {
        if (error || !stdout) { resolve({}); return }

        const children = new Map<number, number[]>()
        const rssMap = new Map<number, number>()

        for (const line of stdout.split('\n')) {
          const parts = line.trim().split(/\s+/)
          if (parts.length < 3) continue
          const pid = parseInt(parts[0], 10)
          const ppid = parseInt(parts[1], 10)
          const rss = parseInt(parts[2], 10)
          if (isNaN(pid) || isNaN(ppid)) continue
          rssMap.set(pid, rss || 0)
          if (!children.has(ppid)) children.set(ppid, [])
          children.get(ppid)!.push(pid)
        }

        const result: Record<string, number> = {}
        for (const session of alive) {
          let totalKB = 0
          const queue = [session.pid!]
          while (queue.length > 0) {
            const p = queue.shift()!
            totalKB += rssMap.get(p) || 0
            const kids = children.get(p) || []
            queue.push(...kids)
          }
          result[session.sessionId] = totalKB * 1024
        }
        resolve(result)
      })
    })
  } catch {
    return {}
  }
})

ipcMain.handle('get-prompt-history', async (_, sessionId: string) => {
  try {
    return await getDaemonClient().getPromptHistory(sessionId)
  } catch {
    return []
  }
})

ipcMain.on('set-active-session', (_, sessionId: string | null) => {
  setActiveSessionId(sessionId || null)
})

ipcMain.on('save-state', (_, data) => {
  const previousData = loadPersistedData()
  saveWorkspaces(
    data.workspaces,
    data.sessions,
    data.activeWorkspaceId,
    data.activeSessionId,
    data.settings,
    data.claudeLastResponse,
    data.codexLastResponse,
  )
  try {
    syncRepositoryWorkspaceSettings(data.workspaces, previousData.workspaces)
  } catch (error) {
    console.error('[main] Failed to sync repository workspace settings:', error)
  }
  recomputeAllSchedules()
})

// Automation IPC handlers
ipcMain.handle('automation-get-runs', (_, actionId: string) => {
  return loadAutomationRuns(actionId)
})

ipcMain.handle('automation-run-now', (_, workspaceId: string, actionId: string) => {
  runAutomationNow(workspaceId, actionId)
})

ipcMain.handle('automation-cancel', (_, actionId: string) => {
  cancelAutomation(actionId)
})

ipcMain.on('automation-action-deleted', (_, actionId: string) => {
  onActionDeleted(actionId)
})

ipcMain.handle('automation-debug-state', () => {
  return getSchedulerDebugState()
})

// Webhook IPC handlers
ipcMain.handle(
  'webhook-enable',
  async (_, workspaceId: string, actionId: string, actionName: string, filter?: string) => {
    const result = await createWebhook(workspaceId, actionId, actionName, filter)
    ensureWebhookListenerRunning()
    return result
  },
)

ipcMain.handle(
  'webhook-disable',
  async (_, _workspaceId: string, _actionId: string, token: string) => {
    await deleteWebhook(token)
    refreshWebhookListener()
  },
)

ipcMain.handle(
  'webhook-update-filter',
  async (_, token: string, filter?: string) => {
    await updateWebhookFilter(token, filter)
  },
)

// Skills IPC handlers
ipcMain.handle('skills-scan', async (_, rootDir: string) => {
  return scanSkills(rootDir)
})

ipcMain.handle('skill-content', async (_, filePath: string) => {
  return getSkillContent(filePath)
})

ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('select-file', async (_event, filters?: { name: string; extensions: string[] }[]) => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters ?? [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('read-file-as-data-url', async (_event, filePath: string) => {
  try {
    const data = fs.readFileSync(filePath)
    const ext = filePath.split('.').pop()?.toLowerCase() ?? 'mp3'
    const mimeMap: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' }
    const mime = mimeMap[ext] ?? 'audio/mpeg'
    return `data:${mime};base64,${data.toString('base64')}`
  } catch {
    return null
  }
})

ipcMain.handle('get-persisted-data', () => {
  return mergeRepositorySettingsIntoPersistedData(loadPersistedData())
})

ipcMain.handle('get-repository-workspace-settings', (_event, rootDir: string) => {
  return loadRepositoryWorkspaceSettings(rootDir)
})

ipcMain.handle(
  'save-repository-workspace-settings',
  (_event, rootDir: string, settings: RepositoryWorkspaceSettings | null) => {
    try {
      saveRepositoryWorkspaceSettings(rootDir, settings)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save repository settings',
      }
    }
  },
)

ipcMain.handle('list-live-sessions', async () => {
  try {
    const sessions = await getDaemonClient().listSessions()
    for (const session of sessions) {
      registerAgentSessionAlias(session.sessionId, session.processSessionId)
    }
    return sessions
  } catch {
    return []
  }
})

ipcMain.handle('list-live-session-statuses', async () => {
  try {
    const sessions = await listLiveSessionStatuses(getDaemonClient())
    for (const session of sessions) {
      registerAgentSessionAlias(session.sessionId, session.processSessionId)
    }
    return sessions
  } catch {
    return []
  }
})

ipcMain.handle('get-git-branch', (_, cwd: string) => {
  return new Promise<string | null>((resolve) => {
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }, (err, stdout) => {
      if (err) return resolve(null)
      resolve(stdout.trim() || null)
    })
  })
})

ipcMain.handle('get-git-pr-info', (_, cwd: string, branch: string) => {
  return new Promise<{ number: number; state: string; title: string; url: string } | null>((resolve) => {
    execFile(
      'gh',
      ['pr', 'view', branch, '--json', 'number,state,isDraft,title,url'],
      { cwd, timeout: 10_000 },
      (err, stdout) => {
        if (err) return resolve(null)
        try {
          const data = JSON.parse(stdout.trim())
          const state = data.isDraft ? 'DRAFT' : data.state // OPEN | CLOSED | MERGED
          resolve({ number: data.number, state, title: data.title ?? '', url: data.url })
        } catch {
          resolve(null)
        }
      }
    )
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
        execFile('git', ['show', `HEAD:${file}`], { cwd, maxBuffer: 5 * 1024 * 1024 }, (_err2, _oldContent) => {
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
    const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')
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

ipcMain.handle('remove-worktree', (_, mainRepoDir: string, worktreeDir: string) => {
  return new Promise<{ success: boolean; error?: string }>((resolve) => {
    execFile('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: mainRepoDir }, (err, _stdout, stderr) => {
      if (!err) {
        // Git removed it successfully — prune for good measure
        execFile('git', ['worktree', 'prune'], { cwd: mainRepoDir }, () => resolve({ success: true }))
        return
      }
      // Git failed — wait for processes to die, then force-remove
      setTimeout(() => {
        execFile('git', ['worktree', 'prune'], { cwd: mainRepoDir }, () => {
          fs.rm(worktreeDir, { recursive: true, force: true }, (rmErr) => {
            if (!rmErr) return resolve({ success: true })
            // Nuclear option: shell rm -rf
            const rmShell = process.env.SHELL || '/bin/sh'
            execFile(rmShell, ['-c', `rm -rf ${JSON.stringify(worktreeDir)}`], (shellErr) => {
              if (shellErr) return resolve({ success: false, error: stderr || err.message })
              resolve({ success: true })
            })
          })
        })
      }, 500)
    })
  })
})

ipcMain.handle('scan-worktrees-dir', (_, repoDir: string, _worktreesDir: string) => {
  return new Promise<{ path: string; branch: string }[]>((resolve) => {
    execFile('git', ['worktree', 'list', '--porcelain'], { cwd: repoDir }, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve([])
        return
      }
      const entries: { path: string; branch: string }[] = []
      let currentPath = ''
      for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          currentPath = line.slice('worktree '.length)
        } else if (line.startsWith('branch ') && currentPath) {
          const branch = line.slice('branch '.length).replace('refs/heads/', '')
          // Skip the main worktree (same as repoDir)
          if (currentPath !== repoDir) {
            entries.push({ path: currentPath, branch })
          }
          currentPath = ''
        } else if (line === '') {
          currentPath = ''
        }
      }
      // Only return entries that still exist on disk
      resolve(entries.filter(e => fs.existsSync(e.path)))
    })
  })
})

ipcMain.handle('get-superset-worktrees', (_, repoPath: string) => {
  const dbPath = join(homedir(), '.superset', 'local.db')

  return new Promise<{ path: string; branch: string }[]>((resolve) => {
    if (!fs.existsSync(dbPath)) {
      resolve([])
      return
    }

    const escapedPath = repoPath.replace(/'/g, "''")
    const query = `SELECT w.path, w.branch FROM worktrees w JOIN projects p ON w.project_id = p.id WHERE p.main_repo_path = '${escapedPath}'`

    execFile('sqlite3', ['-json', dbPath, query], (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve([])
        return
      }
      try {
        const rows = JSON.parse(stdout) as { path: string; branch: string }[]
        resolve(rows.filter(r => fs.existsSync(r.path)))
      } catch {
        resolve([])
      }
    })
  })
})

ipcMain.handle('list-daemon-sessions', async () => {
  return getDaemonClient().listSessions()
})

ipcMain.handle('kill-port', async (_event, pid: number) => {
  try {
    process.kill(pid, 'SIGTERM')
    return { success: true }
  } catch (err: any) {
    // Try SIGKILL as fallback
    try {
      process.kill(pid, 'SIGKILL')
      return { success: true }
    } catch {
      return { success: false, error: err.message }
    }
  }
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

registerLinearSafeStorage(ipcMain)

// App lifecycle
if (hasSingleInstanceLock) {
  app.whenReady().then(createWindow)
}

app.on('window-all-closed', () => {
  stopUpdater()
  stopUsageManager()
  app.quit()
})
