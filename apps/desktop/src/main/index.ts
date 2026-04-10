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
import { initCodexWatcher, watchCodexSession, unwatchCodexSession, stopAllCodexWatchers } from './codex-session-watcher'
import { initTerminalOutputBuffer, stopTerminalOutputBuffer } from './terminal-output-buffer'
import { initIdleNotifier, setActiveSessionId, setOnRequiresUserInput } from './idle-notifier'
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
import { showInterruptionPopup, closeInterruptionPopup, closeAllInterruptionPopups } from './interruption-popup'
import { initUsageManager, stopUsageManager } from './usage-manager'
import { registerLinearSafeStorage } from './linear-safe-storage'
import { AgentIdleReaper, isAgentIdleReaperEnabled } from './agent-idle-reaper'
import { createHookServer, type HookServer } from './hook-server'
import { writeHookPortFile, removeHookPortFile } from './hook-port-file'
import { createClaudeSessionState, type ClaudeHookEvent, type ClaudeSessionState } from './claude-session-state'
import { ensureClaudeHookRuntimeInstalled, CLAUDE_HOOK_EVENT_TYPES } from './claude-hook-runtime'
import {
  detectClaudeHookInstallState,
  installClaudeHooks,
  type ClaudeHookInstallState,
} from './claude-hook-installer'
import {
  startClaudeRunningDetector,
  type ClaudeRunningDetector,
} from './claude-running-detector'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'

let mainWindow: BrowserWindow | null = null
let hookServer: HookServer | null = null
let claudeSessionState: ClaudeSessionState | null = null
let claudeRunningDetector: ClaudeRunningDetector | null = null
let agentIdleReaper: AgentIdleReaper | null = null

interface ClaudeHookEventLogEntry {
  timestamp: number
  orchestraSessionId: string
  claudeSessionId: string
  eventType: string
  message: string
  resultedInStateChange: boolean
  newState: string | null
}

const claudeHookEventLog: ClaudeHookEventLogEntry[] = []
const CLAUDE_HOOK_EVENT_LOG_MAX = 200
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

/**
 * After a Stop hook transitions a Claude session to idle, read the last
 * assistant message from the transcript and ask the remote summarizer
 * whether it needs user input. If it does, override idle → waitingUserInput
 * (but only if the session is still idle — if the user has started a new
 * turn in the meantime, we don't touch the working state).
 *
 * Claude doesn't reliably fire PermissionRequest / Notification hooks for
 * every question it asks (slash-menu prompts, open-ended "what would you
 * like?" questions), so this post-hoc classification catches the gaps.
 */
// Heartbeat detector — synthesizes an end-of-turn Stop event when Claude's
// real Stop hook fires too late (or not at all). After each hook event that
// puts the session in working state, we start a debounce timer. If no more
// events arrive for HEARTBEAT_QUIET_MS, we peek at the transcript and, if
// the last entry is a completed assistant message, synthesize a Stop.
const HEARTBEAT_QUIET_MS = 4000
const workingHeartbeats = new Map<string, ReturnType<typeof setTimeout>>()

function clearWorkingHeartbeat(sessionId: string): void {
  const timer = workingHeartbeats.get(sessionId)
  if (timer) {
    clearTimeout(timer)
    workingHeartbeats.delete(sessionId)
  }
}

function scheduleWorkingHeartbeat(sessionId: string): void {
  clearWorkingHeartbeat(sessionId)
  const timer = setTimeout(() => {
    workingHeartbeats.delete(sessionId)
    if (!claudeSessionState) return
    const current = claudeSessionState.getCurrentState(sessionId)
    if (current !== 'working') return

    console.log('[claude-hook] heartbeat: no events for', HEARTBEAT_QUIET_MS, 'ms, synthesizing Stop', `session=${sessionId.slice(0, 8)}`)
    claudeSessionState.applyHookEvent({
      orchestraSessionId: sessionId,
      claudeSessionId: '',
      eventType: 'Stop',
      message: '',
    })
    // Trigger classify explicitly — the route handler normally does this
    // for real Stops, but the heartbeat bypasses the route handler.
    classifyStopForNeedsUserInput(sessionId).catch((err) => {
      console.error('[claude-hook] heartbeat classify error', err)
    })
  }, HEARTBEAT_QUIET_MS)
  workingHeartbeats.set(sessionId, timer)
}

async function classifyStopForNeedsUserInput(orchestraSessionId: string): Promise<void> {
  const tag = `session=${orchestraSessionId.slice(0, 8)}`
  if (!claudeSessionState) return

  // Resolve the transcript path. Try in order:
  //   1. Path captured from a prior hook event (Stop, PreToolUse, etc.)
  //   2. Compute from cwd + claude session id
  //   3. Glob latest .jsonl in ~/.claude/projects/<cwd-slug>/
  const { readLastAssistantMessage, computeTranscriptPath, findLatestTranscriptForCwd } =
    await import('./claude-transcript-reader')

  let transcriptPath = claudeSessionState.getLastTranscriptPath(orchestraSessionId)
  if (!transcriptPath) {
    const cwd = claudeSessionState.getLastCwd(orchestraSessionId)
    const claudeSessionId = claudeSessionState.getLastClaudeSessionId(orchestraSessionId)
    if (cwd && claudeSessionId) {
      transcriptPath = computeTranscriptPath(cwd, claudeSessionId)
      console.log('[claude-hook] classify: computed transcriptPath from cwd+sessionId', tag, transcriptPath)
    } else if (cwd) {
      transcriptPath = findLatestTranscriptForCwd(cwd)
      console.log('[claude-hook] classify: fell back to latest transcript in cwd dir', tag, transcriptPath)
    }
  } else {
    console.log('[claude-hook] classify: using stored transcriptPath', tag, transcriptPath)
  }

  if (!transcriptPath) {
    console.warn('[claude-hook] classify: SKIPPED — could not resolve transcript path', tag)
    return
  }

  // Retry with small backoff — the transcript file might not have the final
  // assistant message flushed yet when Stop fires. 5 attempts × 400ms = 2s.
  let text: string | null = null
  for (let attempt = 0; attempt < 5; attempt++) {
    text = readLastAssistantMessage(transcriptPath)
    if (text) break
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  if (!text) {
    console.log('[claude-hook] classify: no assistant message found after retries', tag, `path=${transcriptPath}`)
    return
  }
  console.log(
    '[claude-hook] classify: assistant text',
    tag,
    `length=${text.length}`,
    `preview="${text.slice(0, 200).replace(/\n/g, ' ')}${text.length > 200 ? '…' : ''}"`,
  )

  // FAST PATH: local heuristic first. `detectRequiresUserInput` catches
  // question marks and common question phrases instantly, no network.
  const { detectRequiresUserInput } = await import('./prompt-summarizer')
  const localSaysYes = detectRequiresUserInput(text)
  console.log('[claude-hook] classify: local heuristic', tag, `result=${localSaysYes}`)

  if (localSaysYes) {
    // Apply the override immediately — don't wait for the remote.
    const current = claudeSessionState.getCurrentState(orchestraSessionId)
    if (current !== 'idle') {
      console.log('[claude-hook] classify: state drifted from idle before fast-path override', tag, `current=${current}`)
      return
    }
    console.log('[claude-hook] classify: FAST-PATH marking needs-user-input', tag)
    claudeSessionState.markNeedsUserInputIfIdle(orchestraSessionId)
    return
  }

  // SLOW PATH: local heuristic said no. Ask the remote classifier for a
  // second opinion. The remote may catch cases without explicit "?" markers.
  try {
    const { summarizeResponse } = await import('./prompt-summarizer')
    const result = await summarizeResponse(text)
    console.log('[claude-hook] classify: remote result', tag, `requiresUserInput=${result.requiresUserInput}`, `title="${result.title}"`)
    if (!result.requiresUserInput) return

    const current = claudeSessionState.getCurrentState(orchestraSessionId)
    if (current !== 'idle') {
      console.log('[claude-hook] classify: state drifted from idle before remote override', tag, `current=${current}`)
      return
    }
    console.log('[claude-hook] classify: REMOTE marking needs-user-input', tag)
    claudeSessionState.markNeedsUserInputIfIdle(orchestraSessionId)
  } catch (err) {
    console.log('[claude-hook] classify: remote call failed', tag, err instanceof Error ? err.message : String(err))
  }
}

async function liveSessionsForRunningDetector(): Promise<readonly { id: string; pid: number }[]> {
  try {
    const sessions = await listLiveSessionStatuses(getDaemonClient())
    return sessions
      .filter((s) => typeof s.pid === 'number')
      .map((s) => ({ id: s.sessionId, pid: s.pid as number }))
  } catch {
    return []
  }
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

  // Re-emit claude-hooks install state whenever the window regains focus so the
  // install button stays accurate after the user edits ~/.claude/settings.json
  // outside Orchestra.
  mainWindow.on('focus', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const state = detectClaudeHookInstallState()
    mainWindow.webContents.send('claude-hooks:state-changed', state)
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

  // Start the local hook HTTP server BEFORE connecting to the daemon —
  // the daemon reads the port from the file we publish here at every
  // terminal spawn (see daemon/session.ts orchestraChildEnv).
  try {
    hookServer = await createHookServer()
    writeHookPortFile(hookServer.port)
    console.log(`[main] hook server listening on 127.0.0.1:${hookServer.port}`)
  } catch (err) {
    console.error('[main] Failed to start hook server:', err)
  }

  // Ensure the Claude hook script is up to date on every boot. Safe to call
  // on every launch — only rewrites the script file, never settings.json.
  try {
    ensureClaudeHookRuntimeInstalled()
  } catch (err) {
    console.error('[main] Failed to install claude hook runtime:', err)
  }

  // Create the Claude hook state machine and wire its updates to the renderer.
  claudeSessionState = createClaudeSessionState({
    onStatusUpdate: (status: NormalizedAgentSessionStatus) => {
      console.log('[claude-hook] emit', `session=${status.sessionId.slice(0, 8)}`, `state=${status.state}`)
      // Heartbeat bookkeeping: arm when entering working, clear otherwise.
      if (status.state === 'working') {
        scheduleWorkingHeartbeat(status.sessionId)
      } else {
        clearWorkingHeartbeat(status.sessionId)
      }
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send('normalized-agent-state', status)

      // Drive the existing notification path on terminal states. The state
      // is already resolved here, so the notifier doesn't scan terminal buffers.
      // Dynamic import keeps the runtime dependency on idle-notifier loose.
      // NOTE: 'error' state is intentionally not handled — the claude hook
      // state machine never emits it today. If error transitions get added,
      // decide here whether they should fire a notification.
      if (status.state === 'idle' || status.state === 'waitingUserInput' || status.state === 'waitingApproval') {
        const requiresUserInput = status.state === 'waitingUserInput' || status.state === 'waitingApproval'
        import('./idle-notifier').then(({ notifyIdleTransition }) => {
          notifyIdleTransition(status.sessionId, 'claude', undefined, undefined, false, requiresUserInput).catch(() => {})
        }).catch(() => {})
      }

      // On idle, classify the last Claude assistant message with the remote
      // summarizer. Claude doesn't always fire PermissionRequest/Notification
      // for questions (e.g. slash-menu prompts like /focus), so we read the
      // transcript and ask Gemini whether the final message needs input.
      // If it does, we override idle → waitingUserInput.
      // NOTE: classify is NOT triggered here. It's now triggered directly
      // from every Stop event in the hook route handler (and the heartbeat),
      // so real Stops that arrive after a failed synthetic Stop can retry.
      // Triggering from onStatusUpdate would miss those because the state
      // machine de-dupes idle → idle and onStatusUpdate never fires.
    },
  })

  // Register the /claude/hook HTTP route on the hook server.
  if (hookServer) {
    hookServer.registerGetRoute('/claude/hook', async (query) => {
      const orchestraSessionId = query.orchestraSessionId
      const eventType = query.eventType
      if (!orchestraSessionId || !eventType) {
        return { status: 400 }
      }
      if (!CLAUDE_HOOK_EVENT_TYPES.includes(eventType as ClaudeHookEvent['eventType'])) {
        console.warn(`[main] /claude/hook received unknown eventType: ${eventType}`)
        return { status: 400 }
      }
      if (!claudeSessionState) {
        return { status: 503 }
      }
      const before = claudeSessionState.getCurrentState(orchestraSessionId)
      claudeSessionState.applyHookEvent({
        orchestraSessionId,
        claudeSessionId: query.claudeSessionId ?? '',
        eventType: eventType as ClaudeHookEvent['eventType'],
        message: query.message ?? '',
        transcriptPath: query.transcriptPath || undefined,
        cwd: query.cwd || undefined,
      })
      const after = claudeSessionState.getCurrentState(orchestraSessionId)

      // Reset the heartbeat debounce on every event while working —
      // a long streak of PreToolUse/PostToolUse shouldn't trigger it.
      if (after === 'working') {
        scheduleWorkingHeartbeat(orchestraSessionId)
      }

      const entry: ClaudeHookEventLogEntry = {
        timestamp: Date.now(),
        orchestraSessionId,
        claudeSessionId: query.claudeSessionId ?? '',
        eventType,
        message: query.message ?? '',
        resultedInStateChange: before !== after,
        newState: after,
      }
      claudeHookEventLog.push(entry)
      if (claudeHookEventLog.length > CLAUDE_HOOK_EVENT_LOG_MAX) {
        claudeHookEventLog.shift()
      }

      console.log(
        '[claude-hook]',
        eventType,
        query.transcriptPath ? `transcript=${query.transcriptPath.split('/').slice(-2).join('/')}` : 'transcript=<none>',
        `session=${orchestraSessionId.slice(0, 8)}`,
        `${before} → ${after}`,
        query.message ? `msg="${query.message.slice(0, 60)}"` : ''
      )

      // Forward the log entry to the renderer for live debug panel
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('claude-hook:event-logged', entry)
      }

      // Trigger classify on EVERY Stop event, even if the state didn't change
      // (e.g. heartbeat already transitioned idle and the real Stop dedupes).
      // classifyStopForNeedsUserInput is idempotent and guarded by state.
      if (eventType === 'Stop') {
        classifyStopForNeedsUserInput(orchestraSessionId).catch((err) => {
          console.error('[claude-hook] classify error', err)
        })
      }

      return { status: 204 }
    })
  }

  // Poll for claude processes inside Orchestra terminals so the first-run
  // install banner can show only when the user actually launched claude.
  claudeRunningDetector = startClaudeRunningDetector(
    mainWindow,
    liveSessionsForRunningDetector,
  )

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
  initCodexWatcher(mainWindow)
  if (isAgentIdleReaperEnabled()) {
    agentIdleReaper = new AgentIdleReaper({
      client: getDaemonClient(),
    })
    agentIdleReaper.init(mainWindow)
  }
  initTerminalOutputBuffer(mainWindow)
  initIdleNotifier(mainWindow)
  setOnRequiresUserInput((sessionId, _agentType) => {
    // Only show popup when Orchestra is not focused — if the user is
    // already looking at the app they can respond in the main window.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return

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
      agentIdleReaper?.stop()
      agentIdleReaper = null
      stopAllCodexWatchers()
      stopTerminalOutputBuffer()
      stopUsageManager()
      claudeRunningDetector?.stop()
      claudeRunningDetector = null
      if (hookServer) {
        hookServer.stop().catch(() => {})
        hookServer = null
      }
      claudeSessionState = null
      removeHookPortFile()
      client.disconnect()
      mainWindow?.destroy()
    })
  })
}

// IPC Handlers
ipcMain.handle('terminal-create', async (_, sessionId, opts) => {
  const client = getDaemonClient()

  const createOpts = {
    cwd: opts.cwd,
    cols: opts.cols || 80,
    rows: opts.rows || 24,
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
  getDaemonClient().prewarmShell({
    cwd: opts.cwd,
    cols: opts.cols || 120,
    rows: opts.rows || 30,
  }).catch(() => {})
})

ipcMain.on('terminal-write', (_, sessionId, data, source = 'user') => {
  if (source === 'user') {
    agentIdleReaper?.noteActivity(sessionId)

    // Claude's Stop hook does NOT fire when the user interrupts (Esc / Ctrl+C).
    // If the session is currently in a working/waiting state and the user
    // sends an interrupt byte, synthesize a Stop so the sidebar clears.
    if (claudeSessionState && typeof data === 'string' && data.length > 0) {
      const current = claudeSessionState.getCurrentState(sessionId)
      if (current === 'working' || current === 'waitingUserInput' || current === 'waitingApproval') {
        const hasInterrupt = data.includes('\x1b') || data.includes('\x03')
        if (hasInterrupt) {
          console.log('[claude-hook] synthetic Stop from interrupt', `session=${sessionId.slice(0, 8)}`)
          claudeSessionState.applyHookEvent({
            orchestraSessionId: sessionId,
            claudeSessionId: '',
            eventType: 'Stop',
            message: '',
          })
        }
      }
    }
  }
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
  claudeSessionState?.onOrchestraSessionClosed(sessionId)
})

ipcMain.on('interruption-mode-changed', (_, workspaceId: string, enabled: boolean) => {
  if (!enabled) {
    closeAllInterruptionPopups(workspaceId)
  }
})

ipcMain.on('dismiss-interruption-popup', (_, sessionId: string) => {
  closeInterruptionPopup(sessionId)
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

ipcMain.on('codex-watch-session', (_, sessionId: string, cwd: string, codexPid?: number) => {
  watchCodexSession(sessionId, cwd, codexPid)
})

ipcMain.on('codex-unwatch-session', (_, sessionId: string) => {
  unwatchCodexSession(sessionId)
})

// No-op: kept for backward compatibility with renderer calls
ipcMain.on('codex-session-started', () => {})

ipcMain.handle('get-codex-debug-state', () => [])

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
  agentIdleReaper?.setActiveSessionId(sessionId || null)
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

// Claude hooks install state + install action
ipcMain.handle('claude-hooks:get-state', async (): Promise<ClaudeHookInstallState> => {
  return detectClaudeHookInstallState()
})

ipcMain.handle('claude-hooks:install', async () => {
  const result = await installClaudeHooks()
  const nextState = detectClaudeHookInstallState()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claude-hooks:state-changed', nextState)
  }
  return result
})

ipcMain.handle('claude-hooks:get-event-log', async (): Promise<readonly ClaudeHookEventLogEntry[]> => {
  return [...claudeHookEventLog]
})

// Open a file-system path in the OS default handler (Finder, editor, etc.)
ipcMain.handle('open-external-path', async (_event, relativePath: string) => {
  const expanded = relativePath.startsWith('~')
    ? relativePath.replace('~', homedir())
    : relativePath
  await shell.openPath(expanded)
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
    // Run gh through the user's login shell so it inherits the full PATH
    // (gh is typically in /usr/local/bin or /opt/homebrew/bin, which aren't
    // in the default PATH for macOS GUI apps launched from Finder/Dock).
    const loginShell = process.env.SHELL || '/bin/sh'
    const escaped = branch.replace(/'/g, "'\\''")
    const cmd = `gh pr view '${escaped}' --json number,state,isDraft,title,url`
    execFile(
      loginShell,
      ['-l', '-c', cmd],
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
  claudeRunningDetector?.stop()
  claudeRunningDetector = null
  if (hookServer) {
    hookServer.stop().catch(() => {})
    hookServer = null
  }
  claudeSessionState = null
  removeHookPortFile()
  app.quit()
})
