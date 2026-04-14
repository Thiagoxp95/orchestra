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
import {
  getCodexDebugState,
  initCodexWatcher,
  recordCodexHookEvent,
  watchCodexSession,
  unwatchCodexSession,
  stopAllCodexWatchers,
} from './codex-session-watcher'
import { initTerminalOutputBuffer, markWorkingStart, stopTerminalOutputBuffer } from './terminal-output-buffer'
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
import { createHeartbeatDetector, type HeartbeatDetector } from './claude-heartbeat-detector'
import { createCodexSessionState, type CodexHookEvent, type CodexSessionState } from './codex-session-state'
import { ensureCodexHookRuntimeInstalled } from './codex-hook-runtime'
import { CodexAppServerManager } from './codex-app-server-manager'
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
import { isCodexInteractiveInitialCommand } from '../shared/action-utils'

let mainWindow: BrowserWindow | null = null
let hookServer: HookServer | null = null
let claudeSessionState: ClaudeSessionState | null = null
let codexSessionState: CodexSessionState | null = null
let codexAppServerManager: CodexAppServerManager | null = null
let claudeRunningDetector: ClaudeRunningDetector | null = null
let agentIdleReaper: AgentIdleReaper | null = null

const CODEX_HOOK_EVENT_TYPES: ReadonlyArray<CodexHookEvent['eventType']> = [
  'Start',
  'Stop',
  'PermissionRequest',
  'UserInputRequest',
]

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
// real Stop hook fires too late (or not at all). Initialised once the
// session-state module is ready; kept null until then so tests / startup
// don't see a half-wired detector. See claude-heartbeat-detector.ts for the
// transcript-gated synthesis logic.
// 15s quiet window. The v1 value of 4s was adversarial to Claude's streaming
// cadence (tool-use pauses of 5–10s are routine), causing the heartbeat to
// fire mid-turn and synthesize a premature Stop. The transcript gate + turn-ID
// binding already prevent false Stops even at 4s, but 15s also eliminates the
// reschedule churn and keeps the debug log quiet during normal operation.
const HEARTBEAT_QUIET_MS = 15000
let claudeHeartbeat: HeartbeatDetector | null = null

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
  // assistant message flushed yet when Stop fires. In practice the flush is
  // usually already done by the time Stop arrives; these retries only matter
  // for edge cases (slow disk, large transcript). Tightened from 5×400ms=2s
  // to 4×150ms=600ms so the visible idle→waitingUserInput latency stays low.
  let text: string | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    text = readLastAssistantMessage(transcriptPath)
    if (text) break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  if (!text) {
    console.warn(
      '[claude-hook] classify: FAILED — no assistant message found after retries',
      tag,
      `path=${transcriptPath}`,
    )
    return
  }
  console.log(
    '[claude-hook] classify: assistant text',
    tag,
    `length=${text.length}`,
    `preview="${text.slice(0, 200).replace(/\n/g, ' ')}${text.length > 200 ? '…' : ''}"`,
  )

  // Remote classifier is authoritative. A local pattern-matching fast-path
  // was the wrong idea — it flagged jokes ("Why do programmers prefer dark
  // mode?"), rhetorical questions, and example questions in explanations
  // because any `?` or invitation-like phrase triggered it. The Convex-backed
  // LLM (OpenRouter / gpt-5 / gemini) understands context and correctly
  // distinguishes "Claude is asking the user" from "Claude is explaining".
  //
  // If the remote call fails, we do nothing — the session stays `idle`.
  // That's strictly better than a false promotion to `waitingUserInput`.
  try {
    const { summarizeResponse } = await import('./prompt-summarizer')
    const result = await summarizeResponse(text)
    console.log(
      '[claude-hook] classify: remote result',
      tag,
      `requiresUserInput=${result.requiresUserInput}`,
      `title="${result.title}"`,
    )
    if (!result.requiresUserInput) {
      // When the verdict is "no", log the tail of the assistant text too —
      // if the LLM gets a clear question wrong, this is the evidence you need
      // to spot it without digging into transcripts.
      console.log(
        '[claude-hook] classify: remote said NO (session stays idle)',
        tag,
        `tail="${text.slice(-200).replace(/\n/g, ' ')}"`,
      )
      return
    }

    const current = claudeSessionState.getCurrentState(orchestraSessionId)
    if (current !== 'idle') {
      console.log(
        '[claude-hook] classify: state drifted from idle before remote override',
        tag,
        `current=${current}`,
      )
      return
    }
    console.log('[claude-hook] classify: REMOTE marking needs-user-input', tag)
    claudeSessionState.markNeedsUserInputIfIdle(orchestraSessionId)
  } catch (err) {
    // Loud — failures here mean the sidebar won't ever flag "needs input"
    // for this turn. A silent console.log would hide real backend outages.
    console.error(
      '[claude-hook] classify: remote call FAILED — session stays idle',
      tag,
      err instanceof Error ? err.stack ?? err.message : String(err),
    )
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

function emitCodexNormalizedStatus(status: NormalizedAgentSessionStatus): void {
  console.log(
    '[codex-state] emit',
    `session=${status.sessionId.slice(0, 8)}`,
    `state=${status.state}`,
    `authority=${status.authority}`,
    `connected=${status.connected}`,
  )

  if (status.state === 'working') {
    markWorkingStart(status.sessionId)
  }

  agentIdleReaper?.updateStatus(status)
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('normalized-agent-state', status)

  if (!status.connected) return

  if (status.state === 'idle' || status.state === 'waitingUserInput' || status.state === 'waitingApproval') {
    const requiresUserInput = status.state === 'waitingUserInput' || status.state === 'waitingApproval'
    import('./idle-notifier').then(({ notifyIdleTransition }) => {
      notifyIdleTransition(
        status.sessionId,
        'codex',
        undefined,
        undefined,
        false,
        requiresUserInput ? true : undefined,
      ).catch(() => {})
    }).catch(() => {})
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

  try {
    ensureCodexHookRuntimeInstalled()
  } catch (err) {
    console.error('[main] Failed to install codex hook runtime:', err)
  }

  // Create the Claude hook state machine and wire its updates to the renderer.
  claudeSessionState = createClaudeSessionState({
    onStatusUpdate: (status: NormalizedAgentSessionStatus) => {
      console.log(
        '[claude-hook] emit',
        `session=${status.sessionId.slice(0, 8)}`,
        `state=${status.state}`,
        `transition=${status.transition ?? 'status'}`,
        status.turnId ? `turn=${status.turnId.slice(0, 8)}` : '',
      )

      // Heartbeat bookkeeping: arm on turn-started (and refresh on tool-use
      // bumps below in the route handler), clear when the turn ends or
      // attention takes over.
      if (status.transition === 'turn-started') {
        claudeHeartbeat?.schedule(status.sessionId)
      } else if (status.transition === 'turn-ended' || status.transition === 'attention') {
        claudeHeartbeat?.clear(status.sessionId)
      } else if (status.state !== 'working') {
        claudeHeartbeat?.clear(status.sessionId)
      }

      agentIdleReaper?.updateStatus(status)
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send('normalized-agent-state', status)

      // Edge-triggered notifications. We notify ONLY on semantic edges:
      //   - turn-ended: the "Claude finished" toast
      //   - attention:  waitingApproval / waitingUserInput mid-turn
      // Crucially, a status refresh that happens to be in a terminal state
      // (e.g. idle re-emitted as metadata-only) does NOT notify. This is
      // what kills the duplicate / long-after-the-fact "finished" toasts.
      const transition = status.transition ?? 'status'
      // Suppress the "finished" toast when the user themselves interrupted
      // Claude — they just pressed Esc, they're right there, pinging them
      // is noise. Still forward state to the sidebar (done above) so the
      // UI clears.
      const suppressBecauseInterrupted =
        transition === 'turn-ended' && status.wasInterrupted === true
      if (
        !suppressBecauseInterrupted &&
        (transition === 'turn-ended' || transition === 'attention')
      ) {
        const requiresUserInput =
          status.state === 'waitingUserInput' || status.state === 'waitingApproval'
        const turnId = status.turnId
        import('./idle-notifier').then(({ notifyIdleTransition }) => {
          notifyIdleTransition(
            status.sessionId,
            'claude',
            undefined,
            undefined,
            status.wasInterrupted === true,
            requiresUserInput,
            turnId,
          ).catch(() => {})
        }).catch(() => {})
      }

      // On turn-ended, classify the last Claude assistant message with the
      // remote summarizer. Claude doesn't always fire PermissionRequest /
      // Notification for open-ended questions, so we re-read the transcript
      // and may promote idle → waitingUserInput. Triggered here (edge, not
      // every status emit) so we don't re-classify on metadata refreshes.
      // NOTE: classify is ALSO triggered from every real Stop in the route
      // handler (below) — a real Stop that arrives after a synthetic one
      // dedupes at the state machine but should still re-run classification.
    },
  })

  // Transcript-gated heartbeat. Fires only when the transcript's last entry
  // confirms end-of-turn (assistant text, no pending tool_use). Bound to the
  // turnId active at arm time — if the turn rotated by fire time (user hit
  // Esc and re-prompted, or a real Stop arrived first) the synthetic Stop
  // is dropped at the state-machine gate.
  claudeHeartbeat = createHeartbeatDetector({
    quietMs: HEARTBEAT_QUIET_MS,
    getTranscriptPath: (sessionId) =>
      claudeSessionState?.getLastTranscriptPath(sessionId) ?? null,
    isStillWorking: (sessionId) =>
      claudeSessionState?.getCurrentState(sessionId) === 'working',
    getCurrentTurnId: (sessionId) =>
      claudeSessionState?.getCurrentTurnId(sessionId) ?? null,
    synthesizeStop: (sessionId, expectedTurnId) => {
      if (!claudeSessionState) return
      console.log(
        '[claude-hook] heartbeat: transcript confirms end-of-turn, synthesizing Stop',
        `session=${sessionId.slice(0, 8)}`,
        `turn=${expectedTurnId.slice(0, 8)}`,
      )
      claudeSessionState.applyHookEvent({
        orchestraSessionId: sessionId,
        claudeSessionId: '',
        eventType: 'Stop',
        message: '',
        expectedTurnId: expectedTurnId || undefined,
      })
      // The route handler is bypassed for synthetic Stops, so trigger the
      // needs-input classifier manually to keep parity with real Stops.
      classifyStopForNeedsUserInput(sessionId).catch((err) => {
        console.error('[claude-hook] heartbeat classify error', err)
      })
    },
    log: (...args) => console.log('[claude-hook]', ...args),
  })

  codexSessionState = createCodexSessionState({
    onStatusUpdate: emitCodexNormalizedStatus,
  })

  codexAppServerManager = new CodexAppServerManager({
    onStatusUpdate: emitCodexNormalizedStatus,
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

      // Refresh the heartbeat debounce on every hook while working —
      // a long streak of PreToolUse/PostToolUse shouldn't trigger it.
      // (The initial schedule already happens via onStatusUpdate when the
      // state machine emits `turn-started`; this is the re-arm.)
      if (after === 'working') {
        claudeHeartbeat?.schedule(orchestraSessionId)
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

    hookServer.registerGetRoute('/codex/hook', async (query) => {
      const orchestraSessionId = query.sessionId
      const eventType = query.eventType
      if (!orchestraSessionId || !eventType) {
        return { status: 400 }
      }
      if (!CODEX_HOOK_EVENT_TYPES.includes(eventType as CodexHookEvent['eventType'])) {
        console.warn(`[main] /codex/hook received unknown eventType: ${eventType}`)
        return { status: 400 }
      }
      if (!codexSessionState) {
        return { status: 503 }
      }

      const typedEvent = eventType as CodexHookEvent['eventType']
      recordCodexHookEvent(orchestraSessionId, typedEvent)

      if (codexAppServerManager?.isSessionAuthoritative(orchestraSessionId)) {
        console.log(
          '[codex-hook] ignored authoritative fallback event',
          typedEvent,
          `session=${orchestraSessionId.slice(0, 8)}`,
        )
        return { status: 204 }
      }

      const before = codexSessionState.getCurrentState(orchestraSessionId)
      codexSessionState.applyHookEvent({
        orchestraSessionId,
        eventType: typedEvent,
      })
      const after = codexSessionState.getCurrentState(orchestraSessionId)

      console.log(
        '[codex-hook]',
        typedEvent,
        `session=${orchestraSessionId.slice(0, 8)}`,
        `${before} → ${after}`,
      )

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
      claudeHeartbeat?.clearAll()
      claudeHeartbeat = null
      claudeSessionState = null
      codexSessionState = null
      codexAppServerManager?.stop()
      codexAppServerManager = null
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
    launchProfile: opts.launchProfile,
  } as {
    cwd: string
    cols: number
    rows: number
    initialCommand?: string
    launchProfile?: typeof opts.launchProfile
    env?: Record<string, string>
  }

  if (isCodexInteractiveInitialCommand(opts.initialCommand)) {
    let existingSession: Awaited<ReturnType<typeof client.listSessions>>[number] | undefined
    let canProvisionRemoteThread = false
    try {
      existingSession = (await client.listSessions()).find((session) => session.sessionId === sessionId)
      canProvisionRemoteThread = !existingSession || (!existingSession.isAlive && !existingSession.isSuspended)
    } catch {}

    let threadId = codexAppServerManager?.getThreadIdForSession(sessionId) ?? null

    if (!threadId && canProvisionRemoteThread && codexAppServerManager) {
      threadId = await codexAppServerManager.createThread(sessionId, opts.cwd)
    }

    const remoteUrl = codexAppServerManager?.getRemoteUrl()
    if (threadId && remoteUrl) {
      createOpts.env = {
        ...createOpts.env,
        ORCHESTRA_CODEX_REMOTE_URL: remoteUrl,
        ORCHESTRA_CODEX_THREAD_ID: threadId,
      }
    } else if (!canProvisionRemoteThread) {
      console.log(
        '[codex-app-server] attaching existing daemon session without reprovisioning remote thread',
        `session=${sessionId.slice(0, 8)}`,
      )
    }
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
      if (createOpts.env?.ORCHESTRA_CODEX_THREAD_ID) {
        void codexAppServerManager?.unmapSession(sessionId)
      }
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

    // Claude's Stop hook does NOT reliably fire when the user interrupts
    // (Esc / Ctrl+C). Instead of synthesizing an immediate Stop — which
    // caused the "idle flash then new session" flicker when the user
    // retyped right away — we mark the session as pending replacement.
    // The state machine clears that flag on the next observed hook: a new
    // UserPromptSubmit starts a fresh turn silently (no notification), a
    // real Stop closes the turn normally, and a tool-use hook means Claude
    // absorbed the interrupt and is still working. If Claude dies silently
    // under the interrupt, the turn-ID-bound heartbeat is the last resort.
    if (claudeSessionState && typeof data === 'string' && data.length > 0) {
      const hasInterrupt = data.includes('\x1b') || data.includes('\x03')
      if (hasInterrupt) {
        claudeSessionState.noteInterrupt(sessionId)
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
  claudeHeartbeat?.clear(sessionId)
  codexSessionState?.onOrchestraSessionClosed(sessionId)
  void codexAppServerManager?.unmapSession(sessionId)
  import('./idle-notifier').then(({ resetNotifierSession }) => {
    resetNotifierSession(sessionId)
  }).catch(() => {})
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
  codexSessionState?.onOrchestraSessionClosed(sessionId)
  unwatchCodexSession(sessionId)
  void codexAppServerManager?.unmapSession(sessionId)
})

// No-op: kept for backward compatibility with renderer calls
ipcMain.on('codex-session-started', () => {})

ipcMain.handle('get-codex-debug-state', () => getCodexDebugState())

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
  claudeHeartbeat?.clearAll()
  claudeHeartbeat = null
  claudeSessionState = null
  codexSessionState = null
  codexAppServerManager?.stop()
  codexAppServerManager = null
  removeHookPortFile()
  app.quit()
})
