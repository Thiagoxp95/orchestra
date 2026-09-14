import { configureNativeChatHost, executeNativeChat, nativeChatManager, nativeChatSnapshot, stopNativeChat } from './native-chat/service'
import { nativeChatStateChanged } from './remote-bridge'
import { nativeChatNormalizedStatus } from '../shared/native-chat'
// src/main/index.ts
import { app, BrowserWindow, dialog, ipcMain, Menu, powerSaveBlocker, screen, shell, systemPreferences } from 'electron'
import { dirname, join } from 'node:path'
import * as fs from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { is } from '@electron-toolkit/utils'
import { getDaemonClient } from './daemon-client'
import { registerAgentSessionAlias } from './agent-session-aliases'
import { getSessionStatus, listLiveSessionStatuses, startMonitoring, stopMonitoring } from './process-monitor'
import { killRunningServer, scanRunningServers } from './running-servers'
import { publishMobileAccess, resolveMobileAccess, unpublishMobileAccess } from './mobile-access'
import { findTailscale, TAILSCALE_DOWNLOAD_URL } from './tailscale'
import {
  getTerminalBufferText,
  hasRecentTerminalOutput,
  initTerminalOutputBuffer,
  markWorkingStart,
  stopTerminalOutputBuffer,
} from './terminal-output-buffer'
import { agentChatLog } from './agent-chat-log'
import { runKeySteps, sanitizeKeySteps } from './remote-bridge-key-steps'
import { QUIET_MS, submitChatMessage } from './remote-bridge-chat-send'
import { chatInputController, guardedChatInput } from './chat-input-controller'
import { saveRemoteImage } from './remote-bridge-image'
import { ensureSlashCommandCatalog } from './remote-bridge-commands'
import { initIdleNotifier, setActiveSessionId, setOnRequiresUserInput } from './idle-notifier'
import {
  forgetRemoteBridgeNotify,
  noteRemoteBridgeWorking,
  setRemoteNotifyStatusResolver,
} from './remote-bridge-notify'
import { initUpdater, stopUpdater } from './updater'
import {
  loadPersistedData,
  saveWorkspaces,
  savePersistedData,
  getStoreFilePath,
  loadAutomationRuns,
  saveAutomationRun,
  loadVoiceIntroSeen,
  saveVoiceIntroSeen,
  loadVoiceSetupAttempted,
  saveVoiceSetupAttempted,
  loadVoiceSetupCardDismissed,
  saveVoiceSetupCardDismissed,
} from './persistence'
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
  handleWebhookEvent,
} from './webhook-listener'
import { startLocalServer, stopLocalServer } from './local-server'
import { setOpenRouterKeyProvider } from './local-server/summarize'
import { decryptStringFromStorage } from './linear-safe-storage'
import { registerIssueBoardIpc } from './issue-board-ipc'
import { startRemoteBridge, stopRemoteBridge, remoteBridgeOnStatePersisted, remoteBridgeOnMirror, remoteBridgeOnResize, remoteBridgeDesktopGeometry, remoteBridgeReclaimDesktop, remoteBridgeSetCodexTranscriptResolver, remoteBridgeOnClaudeTranscript, remoteBridgeOnClaudeQuestion, remoteBridgeMessageMirrorSnapshot, getAgentContextSnapshot, getMirrorSnapshot, getChatReadySessions, remoteBridgeOnChatReady } from './remote-bridge'
import { remoteBridgeOnSessionResumePairing, remoteBridgeOnExitedSessions, getExitedSessions, assertChatSessionWritable } from './remote-bridge'
import { getMessageMirrorLogPath } from './message-mirror-log'
import { getPullRequest } from './pr-mirror'
import { startDictationOrchestrator } from './dictation/dictation-orchestrator'
import { reconcilePersistedWorktrees } from './reconcile-worktrees'
import {
  backupPrunedTrees,
  backupWorktree,
  listWorktreeBackups,
  pruneOldBackups,
  restoreWorktreeBackup,
  sessionsUnderDir,
  snapshotStoreIfStale,
} from './worktree-backup'
import {
  dropPendingDeletion,
  enqueuePendingDeletion,
  removeWorktreeFromDisk,
  retryPendingDeletions,
} from './worktree-removal'
import { SNAPSHOTS_DIR } from '../daemon/protocol'
import { HistoryWriter } from '../daemon/history-writer'
import { scanSkills, getSkillContent } from './skill-scanner'
import type { RepositoryWorkspaceSettings } from '../shared/types'
import { normalizeVoiceWakeWord } from '../shared/types'
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
import { runHeadlessAgent } from './run-headless-agent'
import { VoiceManager } from './voice/voice-manager'
import { spawnPythonSidecar } from './voice/python-sidecar'
import { VoiceSetup } from './voice/voice-setup'
import type {
  VoiceEvent,
  VoiceSettings,
  VoiceSetupProgressEvent,
  VoiceSetupStatus,
  VoiceStatus,
  VoiceVocabularyEntry,
} from '../shared/types'
import { AgentIdleReaper, isAgentIdleReaperEnabled } from './agent-idle-reaper'
import { AgentSleepBlocker } from './agent-sleep-blocker'
import { CodexNotifyListener } from './codex-notify-listener'
import { CodexRolloutWatcher } from './codex-rollout-watcher'
import { ensureCodexHooksRegistered } from './codex-hooks-setup'
import { ClaudeNotifyListener } from './claude-notify-listener'
import { getClaudeHookPortPath, getCodexHookPortPath } from './orchestra-paths'
import { ensureClaudeHooksRegistered } from './claude-hooks-setup'
import { buildGitSigningGuardEnv, ensureGitSigningGuardScript } from './git-signing-guard'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'
import {
  CLAUDE_INTERACTIVE_COMMAND_PREVIEW,
  CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW,
  CLAUDE_PRINT_COMMAND_PREVIEW,
  CODEX_PRINT_COMMAND_PREVIEW,
  CODEX_PRINT_SHELL_COMMAND_PREVIEW,
  isAgentResumeCommand,
  isCodexInteractiveInitialCommand,
} from '../shared/action-utils'
import { listRecentAgentSessions } from './agent-session-history'

let mainWindow: BrowserWindow | null = null
let codexNotifyListener: CodexNotifyListener | null = null
let codexRolloutWatcher: CodexRolloutWatcher | null = null
let codexHookPort: number | null = null
let claudeNotifyListener: ClaudeNotifyListener | null = null
let claudeHookPort: number | null = null
let agentIdleReaper: AgentIdleReaper | null = null
let agentSleepBlocker: AgentSleepBlocker | null = null
let voiceManager: VoiceManager | null = null
let voiceSettings: VoiceSettings | null = null
let voiceSetup: VoiceSetup | null = null
const interruptedCodexIdleNotifications = new Set<string>()

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

function emitCodexNormalizedStatus(status: NormalizedAgentSessionStatus): void {
  if (nativeChatSnapshot(status.sessionId)) return
  console.log(
    '[codex-state] emit',
    `session=${status.sessionId.slice(0, 8)}`,
    `state=${status.state}`,
    `authority=${status.authority}`,
    `connected=${status.connected}`,
  )

  if (status.state === 'working') {
    markWorkingStart(status.sessionId)
    // A new turn retires whatever the phone was last told about this session,
    // and kills any push still settling from the turn that just resumed.
    noteRemoteBridgeWorking(status.sessionId)
  }

  agentSleepBlocker?.updateNormalizedStatus(status)
  agentIdleReaper?.updateStatus(status)
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('normalized-agent-state', status)

  if (!status.connected) return

  // A codex event on a Claude-owned pane is Claude shelling out to codex as a
  // tool (computer-use, review passes). The codex run finishing says nothing
  // about the session's turn, so notifying "Finished" here interrupts the user
  // with a completion for an agent that is still working. The renderer already
  // drops these cross-agent events (see process-monitor's process-change
  // ordering note); the notifier is applying the same rule.
  if (getSessionStatus(status.sessionId) === 'claude') {
    console.log(
      '[codex-state] idle notification suppressed session=%s — nested codex under claude',
      status.sessionId.slice(0, 8),
    )
    return
  }

  if (status.state === 'idle' || status.state === 'waitingUserInput' || status.state === 'waitingApproval') {
    const requiresUserInput = status.state === 'waitingUserInput' || status.state === 'waitingApproval'
    const wasInterrupted = status.state === 'idle' && interruptedCodexIdleNotifications.delete(status.sessionId)
    import('./idle-notifier').then(({ notifyIdleTransition }) => {
      notifyIdleTransition(
        status.sessionId,
        'codex',
        undefined,
        undefined,
        wasInterrupted,
        requiresUserInput ? true : undefined,
      ).catch(() => {})
    }).catch(() => {})
  }
}

/**
 * The most recently updated normalized status for a session, whichever listener
 * holds it. Both can have an entry for the same session — Claude shelling out to
 * `codex` files codex-tagged events under the parent's Orchestra session id — so
 * "freshest wins" rather than a fixed listener order.
 */
function freshestNormalizedState(sessionId: string): NormalizedAgentSessionStatus | null {
  const native = nativeChatSnapshot(sessionId)
  if (native) return nativeChatNormalizedStatus(native)
  const codex = codexNotifyListener?.getLatest(sessionId) ?? null
  const claude = claudeNotifyListener?.getLatest(sessionId) ?? null
  if (!codex) return claude
  if (!claude) return codex
  return codex.updatedAt >= claude.updatedAt ? codex : claude
}

function emitClaudeNormalizedStatus(status: NormalizedAgentSessionStatus): void {
  if (nativeChatSnapshot(status.sessionId)) return
  console.log(
    '[claude-state] emit',
    `session=${status.sessionId.slice(0, 8)}`,
    `state=${status.state}`,
    `authority=${status.authority}`,
  )

  if (status.state === 'working') {
    markWorkingStart(status.sessionId)
    // A new turn retires whatever the phone was last told about this session,
    // and kills any push still settling from the turn that just resumed.
    noteRemoteBridgeWorking(status.sessionId)
  }

  agentSleepBlocker?.updateNormalizedStatus(status)
  agentIdleReaper?.updateStatus(status)
  if (!mainWindow || mainWindow.isDestroyed()) return
  // Same renderer channel as codex — computeAgentView keys off `status.agent`,
  // so a claude-tagged payload drives the claude session's shimmer/attention.
  mainWindow.webContents.send('normalized-agent-state', status)

  // NB: intentionally no idle-notifier call here. Claude's idle/needs-input
  // toasts are already fired from the OSC-title path in daemon-client.ts
  // (working→idle and picker→waitingUserInput). Re-firing from the hook stream
  // would double-toast. The hook path improves the *visual* state precision;
  // the notification path is unchanged.
}

function isAgentInitialCommand(initialCommand?: string): boolean {
  if (!initialCommand) return false
  const trimmed = initialCommand.trim()
  return (
    trimmed === 'claude'
    || trimmed.startsWith('claude ')
    || trimmed === CLAUDE_INTERACTIVE_COMMAND_PREVIEW
    || trimmed.startsWith(`${CLAUDE_INTERACTIVE_COMMAND_PREVIEW} `)
    || trimmed === CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW
    || trimmed.startsWith(`${CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW} `)
    || trimmed === CLAUDE_PRINT_COMMAND_PREVIEW
    || trimmed.startsWith(`${CLAUDE_PRINT_COMMAND_PREVIEW} `)
    || isCodexInteractiveInitialCommand(trimmed)
    || isAgentResumeCommand(trimmed)
    || trimmed === CODEX_PRINT_COMMAND_PREVIEW
    || trimmed.startsWith(`${CODEX_PRINT_COMMAND_PREVIEW} `)
    || trimmed === CODEX_PRINT_SHELL_COMMAND_PREVIEW
    || trimmed.startsWith(`${CODEX_PRINT_SHELL_COMMAND_PREVIEW} `)
  )
}

async function createWindow(): Promise<void> {
  // Prune worktrees deleted out-of-band (agent self-cleanup, manual `git worktree
  // remove`) before anything reads the store, so the desktop UI and the web/phone
  // mirror never show a worktree whose directory is gone. Runs before the renderer
  // fetches persisted data and before the remote bridge's first push.
  const reconciled = reconcilePersistedWorktrees(loadPersistedData())
  if (reconciled.removedTrees > 0) {
    // Point-in-time recovery: save what's about to be pruned BEFORE the store
    // is rewritten, so an out-of-band deletion is never silent data loss.
    const backupFile = backupPrunedTrees(reconciled.prunedTrees, reconciled.prunedSessions)
    savePersistedData(reconciled.data)
    console.log(
      `[reconcile] pruned ${reconciled.removedTrees} missing worktree(s) and ${reconciled.removedSessions} dead session(s) from the store`
        + (backupFile ? ` (backed up to ${backupFile})` : ''),
    )
  }

  // Rolling point-in-time snapshots of the whole store, retained 30 days.
  const snapshot = snapshotStoreIfStale(getStoreFilePath())
  if (snapshot) console.log(`[backup] store snapshot written to ${snapshot}`)
  pruneOldBackups()
  const storeSnapshotTimer = setInterval(() => {
    snapshotStoreIfStale(getStoreFilePath())
    pruneOldBackups()
  }, 60 * 60 * 1000)
  storeSnapshotTimer.unref?.()

  // Worktrees whose files survived every removal attempt last session (usually
  // an EMFILE storm at delete time) — the UI dropped them optimistically, so
  // finish the job now that the machine is quiet.
  void retryPendingDeletions().then(({ removed, remaining }) => {
    if (removed || remaining) console.log(`[worktree] pending deletions: ${removed} removed, ${remaining} still queued`)
  })

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

  // Codex idle/working state pipeline:
  //   codex CLI → ~/.codex/hooks.json → ~/.orchestra/hooks/codex-notify.sh
  //             → POST http://127.0.0.1:<port>/codex-hook → emit normalized status
  try {
    const setup = ensureCodexHooksRegistered()
    if (setup) {
      console.log(
        '[codex-hooks] registered',
        `notify=${setup.notifyPath}`,
        `hooksChanged=${setup.hooksChanged}`,
        `scriptChanged=${setup.scriptChanged}`,
      )
      if (setup.removedLegacyArtifacts.length > 0) {
        console.log('[codex-hooks] removed legacy artifacts:', setup.removedLegacyArtifacts.join(', '))
      }
    }
  } catch (err) {
    console.warn('[codex-hooks] failed to register codex hooks:', err)
  }

  // Claude idle/working state pipeline:
  //   claude CLI → ~/.claude/settings.json → ~/.orchestra/hooks/claude-notify.sh
  //             → POST http://127.0.0.1:<port>/claude-hook → emit normalized status
  // Supersedes the OSC-title spinner-glyph heuristic; the title scraper stays a
  // fallback for the pre-install window and sessions whose hooks never fire.
  try {
    const setup = ensureClaudeHooksRegistered()
    if (setup) {
      console.log(
        '[claude-hooks] registered',
        `notify=${setup.notifyPath}`,
        `hooksChanged=${setup.hooksChanged}`,
        `scriptChanged=${setup.scriptChanged}`,
      )
    }
  } catch (err) {
    console.warn('[claude-hooks] failed to register claude hooks:', err)
  }

  try {
    const setup = ensureGitSigningGuardScript()
    console.log(
      '[git-signing-guard] registered',
      `path=${setup.path}`,
      `changed=${setup.changed}`,
    )
  } catch (err) {
    console.warn('[git-signing-guard] failed to register git guard:', err)
  }

  codexRolloutWatcher = new CodexRolloutWatcher({
    onEvent: (sessionId, event) => {
      // The rollout JSONL is the deterministic source of truth for codex
      // state — it records `task_started` / `task_complete` / `turn_aborted`
      // / `error` for every turn and is appended live during the turn.
      // Whatever the watcher emits, push it straight through the listener
      // with codex-rollout authority.
      if (!codexNotifyListener) return
      if (event.aborted) {
        interruptedCodexIdleNotifications.add(sessionId)
      }
      codexNotifyListener.applyExternalState(sessionId, event.state, 'codex-rollout')
    },
  })

  // The rollout watcher resolves each codex session's transcript exactly (lsof
  // against the live process, with sub-worker vetoes); the remote bridge's
  // context tracker reads the token counts out of that same file rather than
  // re-deriving the path.
  remoteBridgeSetCodexTranscriptResolver((sessionId) => {
    const entry = codexRolloutWatcher
      ?.getDebugState()
      .find((e) => e.orchestraSessionId === sessionId)
    return entry?.fileExists ? entry.transcriptPath : null
  })

  codexNotifyListener = new CodexNotifyListener({
    onStatusUpdate: emitCodexNormalizedStatus,
    onSessionInfo: (info) => {
      // codex's hook payload always carries `session_id`, but `transcript_path`
      // is null until the rollout file is materialized. Sub-workers spawned by
      // codex's apps feature inherit the parent's ORCHESTRA_CODEX_SESSION_ID
      // and fire hooks with their *own* session_id+transcript_path attributed
      // to the parent — accepting those blindly swaps the watcher to the
      // sub-worker's short-lived rollout (fires task_complete then exits,
      // surfaces as a spurious FINISHED toast). `applyHookProvidedPath`
      // vetoes the swap when lsof says the current attach is still the file
      // codex actually has open.
      if (info.transcriptPath) {
        codexRolloutWatcher?.applyHookProvidedPath(info.sessionId, info.transcriptPath)
      } else {
        codexRolloutWatcher?.attachByCodexSessionId(info.sessionId, info.codexSessionId)
      }
    },
  })
  try {
    codexHookPort = await codexNotifyListener.start()
    console.log('[codex-hooks] notify listener bound to 127.0.0.1:' + codexHookPort)
    writeHookPortFile(getCodexHookPortPath(), codexHookPort)
  } catch (err) {
    console.warn('[codex-hooks] failed to start notify listener:', err)
    codexHookPort = null
  }

  claudeNotifyListener = new ClaudeNotifyListener({
    onStatusUpdate: emitClaudeNormalizedStatus,
    onTranscriptPath: remoteBridgeOnClaudeTranscript,
    onQuestion: remoteBridgeOnClaudeQuestion,
  })
  // The notify scripts prefer this file over the env port stamped at PTY
  // spawn, so sessions from previous app runs keep reporting here — see
  // getClaudeHookPortPath. Best-effort: a failed write leaves them on the
  // env fallback, no worse than before the file existed.
  function writeHookPortFile(filePath: string, port: number): void {
    try {
      fs.mkdirSync(dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, String(port))
    } catch (err) {
      console.warn('[hooks] failed to write port file', filePath, err)
    }
  }
  try {
    claudeHookPort = await claudeNotifyListener.start()
    console.log('[claude-hooks] notify listener bound to 127.0.0.1:' + claudeHookPort)
    writeHookPortFile(getClaudeHookPortPath(), claudeHookPort)
  } catch (err) {
    console.warn('[claude-hooks] failed to start notify listener:', err)
    claudeHookPort = null
  }

  agentSleepBlocker = new AgentSleepBlocker({ powerSaveBlocker })

  // Phone pushes are fired from the OSC-title path, which flaps; they are held
  // for a few seconds and then confirmed against this — the hook stream, which
  // is authoritative but deliberately fires no notifications of its own.
  setRemoteNotifyStatusResolver((sessionId) => {
    // Only the pane's own agent may confirm or veto its push. Claude shelling
    // out to codex files codex-tagged events under this same session id, and
    // "freshest wins" would let that nested run — idle the moment it returns —
    // vouch for a Claude turn that is still going.
    const owner = getSessionStatus(sessionId)
    const normalized =
      owner === 'claude' ? claudeNotifyListener?.getLatest(sessionId) ?? null
      : owner === 'codex' ? codexNotifyListener?.getLatest(sessionId) ?? null
      : freshestNormalizedState(sessionId)
    if (normalized) return normalized.state
    const claudeState = getDaemonClient().getClaudeWorkState(sessionId)
    return claudeState ?? null
  })

  // Connect to daemon
  const client = getDaemonClient()
  client.setClaudeWorkStateHandler((sessionId, state) => {
    agentSleepBlocker?.updateClaudeWorkState(sessionId, state)
    // Claude's OSC title reconciles the hook stream. An interrupted turn (Esc)
    // fires no Stop/StopFailure/PostToolUse, so without this the last hook
    // event ('working') stays latched and the sidebar shimmers on an idle pane.
    // The listener decides what the title is allowed to correct.
    claudeNotifyListener?.applyExternalState(sessionId, state, 'claude-osc')
  })
  client.setTerminalExitHandler((sessionId) => {
    agentSleepBlocker?.forgetSession(sessionId)
    codexRolloutWatcher?.unwatchSession(sessionId)
    codexNotifyListener?.forgetSession(sessionId)
    claudeNotifyListener?.forgetSession(sessionId)
    // A PTY that exits mid-settle takes its pending push with it — the state it
    // would be confirmed against is gone.
    forgetRemoteBridgeNotify(sessionId)
  })
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

  startMonitoring(mainWindow, client, (sessionId, status, aiPid, cwd) => {
    agentSleepBlocker?.updateProcessStatus(sessionId, status)
    if (status === 'codex' && cwd) {
      // Pass aiPid so the watcher can use lsof on codex's process tree to
      // find the exact rollout file it has open — no cwd-heuristics, no
      // dependency on hook approval. Falls back to cwd-matching internally
      // when lsof is unavailable.
      codexRolloutWatcher?.scheduleDiscovery(sessionId, cwd, aiPid)
    } else if (status !== 'codex') {
      codexRolloutWatcher?.unwatchSession(sessionId)
    }
  })
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
  // The phone's server: web app, sync socket, terminal relay, uploads, and
  // inbound webhooks on one loopback port that Tailscale Serve publishes. The
  // bridge and the dictation orchestrator serve INTO it, so it comes up first.
  try {
    await startLocalServer({ onWebhookEvent: handleWebhookEvent })
  } catch (err) {
    console.error('[local-server] failed to start — phone access disabled', err)
  }
  startWebhookListener(mainWindow)
  startRemoteBridge(mainWindow)
  startDictationOrchestrator()
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

    handoffPromise.then(async () => {
      await nativeChatManager().close().catch(console.error)
      stopWebhookListener()
      stopRemoteBridge()
      await stopLocalServer().catch(console.error)
      stopAutomationScheduler()
      stopMonitoring()
      agentSleepBlocker?.stop()
      agentSleepBlocker = null
      agentIdleReaper?.stop()
      agentIdleReaper = null
      stopTerminalOutputBuffer()
      stopUsageManager()
      codexNotifyListener?.stop()
      codexNotifyListener = null
      codexRolloutWatcher?.stop()
      codexRolloutWatcher = null
      codexHookPort = null
      voiceManager?.disable()
      voiceManager = null
      client.disconnect()
      mainWindow?.destroy()
    })
  })
}

configureNativeChatHost({
  session: id => getMirrorSnapshot().sessions[id],
  isWorking: id => ['working', 'waitingApproval', 'waitingUserInput'].includes(freshestNormalizedState(id)?.state ?? ''),
  messages: (id, messages) => {
    const user = [...messages].reverse().find(message => message.role === 'user')
    const label = user?.blocks.filter(block => block.kind === 'text').map(block => block.text).join(' ').trim()
    if (label && !label.startsWith('/')) mainWindow?.webContents.send('session-label-update', id, label.slice(0, 200))
  },
  changed: snapshot => {
    mainWindow?.webContents.send('native-chat-state', snapshot)
    mainWindow?.webContents.send('process-change', snapshot.sessionId, snapshot.provider)
    const status = nativeChatNormalizedStatus(snapshot)
    mainWindow?.webContents.send('normalized-agent-state', status)
    agentSleepBlocker?.updateNormalizedStatus(status)
    nativeChatStateChanged()
  },
})

// IPC Handlers
ipcMain.handle('native-chat-get', (_event, id: string) => nativeChatSnapshot(id))
ipcMain.handle('native-chat-list', () => [])
ipcMain.handle('native-chat-command', (_event, id: string, command: unknown) => executeNativeChat(id, command))
ipcMain.handle('terminal-create', async (_, sessionId, opts) => {
  const client = getDaemonClient()

  const createOpts = {
    cwd: opts.cwd,
    ...remoteBridgeDesktopGeometry(opts.cols || 80, opts.rows || 24, sessionId),
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

  // Always tag every PTY with the codex hook env. The user can run `codex` from
  // any shell (not just codex-launched sessions), and the codex-notify.sh hook
  // exits early without these vars — leaving the renderer with no live signal
  // and the sidebar stuck on idle while codex is actually working. The vars are
  // inert until something actually invokes codex.
  const codexEnv: Record<string, string> = { ORCHESTRA_CODEX_SESSION_ID: sessionId }
  if (codexHookPort != null) {
    codexEnv.ORCHESTRA_CODEX_HOOK_PORT = String(codexHookPort)
  }
  createOpts.env = { ...createOpts.env, ...codexEnv }

  // Same rationale as codex: tag every PTY with the claude hook env so a
  // `claude` invoked from any shell (not just claude-launched sessions) reports
  // its state. The claude-notify.sh hook exits early without these vars, so
  // they're inert until something actually runs claude.
  const claudeEnv: Record<string, string> = { ORCHESTRA_CLAUDE_SESSION_ID: sessionId }
  if (claudeHookPort != null) {
    claudeEnv.ORCHESTRA_CLAUDE_HOOK_PORT = String(claudeHookPort)
  }
  createOpts.env = { ...createOpts.env, ...claudeEnv }

  if (isAgentInitialCommand(opts.initialCommand) || opts.launchProfile?.kind === 'exec') {
    createOpts.env = buildGitSigningGuardEnv(createOpts.env)
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

  return {
    success: true, restoredSnapshot,
    liveGeometry: { cols: result.snapshot?.cols ?? createOpts.cols, rows: result.snapshot?.rows ?? createOpts.rows },
  }
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
  }
  getDaemonClient().write(sessionId, data, source)
})

ipcMain.on('terminal-resize', (_, sessionId, cols, rows) => {
  const geometry = remoteBridgeDesktopGeometry(cols, rows, sessionId)
  getDaemonClient().resize(sessionId, geometry.cols, geometry.rows).catch(() => {})
  // Mirror the desktop's geometry so an attached phone follows its width.
  remoteBridgeOnResize(sessionId, cols, rows)
})

// The desktop reclaims geometry ownership when the user clicks/opens a session
// on the computer (renderer sends this on active-session change). cols/rows are
// the active terminal's geometry so the bridge can eagerly resize every open PTY
// back to the desktop's size; both are optional.
ipcMain.on('remote-claim-desktop', (_, cols?: number, rows?: number, sessionId?: string) => {
  void remoteBridgeReclaimDesktop(cols, rows, sessionId)
})

ipcMain.on('show-emoji-panel', () => {
  app.showEmojiPanel()
})

ipcMain.on('terminal-kill', (_, sessionId) => {
  void stopNativeChat(sessionId).catch(console.error)
  getDaemonClient().kill(sessionId).catch(() => {})
  agentSleepBlocker?.forgetSession(sessionId)
  codexRolloutWatcher?.unwatchSession(sessionId)
  codexNotifyListener?.forgetSession(sessionId)
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
      const geometry = remoteBridgeDesktopGeometry(cols, rows, sessionId)
      await getDaemonClient().resize(sessionId, geometry.cols, geometry.rows)
    }
    return await getDaemonClient().getSnapshot(sessionId)
  } catch {
    return null
  }
})

// Codex state is now driven entirely by ~/.codex/hooks.json + the localhost
// notify listener (see codex-notify-listener.ts). The renderer-facing IPCs
// below are kept as no-ops while the old renderer plumbing is still calling
// them; they can be deleted once the renderer is cleaned up.
ipcMain.on('codex-watch-session', (_, sessionId: string) => {
  void sessionId
})

ipcMain.on('codex-unwatch-session', (_, sessionId: string) => {
  agentSleepBlocker?.clearNormalizedStatus(sessionId)
  codexRolloutWatcher?.unwatchSession(sessionId)
  codexNotifyListener?.forgetSession(sessionId)
})

ipcMain.on('codex-session-started', (_, sessionId: string) => {
  codexNotifyListener?.markRunStarted(sessionId)
})

ipcMain.handle('get-codex-debug-state', () => {
  if (!codexRolloutWatcher) return []
  const persisted = loadPersistedData()
  return codexRolloutWatcher.getDebugState().map((entry) => {
    const session = persisted.sessions[entry.orchestraSessionId]
    return {
      sessionId: entry.orchestraSessionId,
      cwd: session?.cwd ?? '',
      lastWorkState: entry.lastState === 'working' ? 'working' : 'idle',
      transcriptPath: entry.transcriptPath,
      fileExists: entry.fileExists,
      lastEventAt: entry.lastEventAt ? new Date(entry.lastEventAt).toISOString() : null,
      source: 'rollout' as const,
    }
  })
})

ipcMain.handle('get-claude-work-state', (_event, sessionId: string) => {
  return getDaemonClient().getClaudeWorkState(sessionId)
})

ipcMain.handle('get-normalized-agent-state', (_event, sessionId: string) => {
  return freshestNormalizedState(sessionId)
})

ipcMain.handle('get-work-state-debug-snapshot', (_event, lineCount?: number) => {
  return getWorkStateDebugSnapshot(lineCount)
})

// Chat-mirror health: which sessions are stalled and why (buffer depth, last
// progress, failure count, head uid/seq) plus the on-disk trace path. The
// answer to "the phone's chat froze but the terminal is fine" without a restart.
ipcMain.handle('get-message-mirror-debug-snapshot', () => {
  return { logPath: getMessageMirrorLogPath(), entries: remoteBridgeMessageMirrorSnapshot() }
})

// ── Chat view ───────────────────────────────────────────────────────────────
// The desktop's structured chat pane reads the SAME parsed messages the phone
// does, but straight out of this process (agent-chat-log.ts) rather than via
// Convex: no round trip, no network dependency, and rows appear the moment the
// transcript tailer parses them. Everything below is the local twin of a
// remote-bridge command the web sends.

ipcMain.handle('chat-since', (_event, sessionId: string, afterSeq: number) => {
  return agentChatLog.since(sessionId, Number.isFinite(afterSeq) ? afterSeq : -1)
})

ipcMain.handle(
  'chat-before',
  (_event, sessionId: string, beforeSeq: number, limit: number) => {
    const before = Number.isFinite(beforeSeq) ? beforeSeq : Number.MAX_SAFE_INTEGER
    return agentChatLog.before(sessionId, before, Math.min(Math.max(1, limit || 60), 400))
  },
)

/** Context-window occupancy + the model/effort each session actually runs. */
ipcMain.handle('chat-agent-context', () => getAgentContextSnapshot())

/**
 * Which sessions have a conversation to show — the pane offers its chat view
 * only for these. Pulled once on mount and pushed on every change, because the
 * pairing lands asynchronously (hook report, then the first successful read of
 * the transcript) after the agent is already running.
 */
ipcMain.handle('chat-ready-sessions', () => getChatReadySessions())
remoteBridgeOnChatReady((sessionIds) => {
  mainWindow?.webContents.send('chat-ready-sessions', sessionIds)
})

/**
 * Which conversation each agent pane is holding. Forwarded to the renderer,
 * which writes it onto the session row so it survives a restart — that row is
 * the only thing left after a reboot that knows what was open in this pane.
 */
remoteBridgeOnSessionResumePairing((sessionId, pairing) => {
  mainWindow?.webContents.send('session-resume-pairing', sessionId, pairing)
})

/**
 * Sessions whose PTY is confirmed gone. The sidebar gates its resume button on
 * this — a row is only offered a resume once there is nothing running in it.
 */
ipcMain.handle('exited-sessions', () => getExitedSessions())
remoteBridgeOnExitedSessions((sessionIds) => {
  mainWindow?.webContents.send('exited-sessions', sessionIds)
})

/**
 * The user's own commands for the composer's autocomplete — for claude the
 * skills, ~/.claude/commands, plugins and repo .claude/commands; for codex
 * ~/.agents/skills, ~/.codex/skills and ~/.codex/prompts. Scanned lazily on the
 * catalog's own 5-minute clock — the wait is a no-op when it's fresh.
 *
 * Awaited, not fire-and-forget: the renderer polls this once on mount and then
 * only every 60s, so returning the empty pre-scan cache meant the first minute
 * of every session autocompleted built-ins only.
 */
ipcMain.handle(
  'chat-slash-commands',
  async (_event, workspaceId: string, agent: 'claude' | 'codex' = 'claude') => {
    const data = getMirrorSnapshot()
    const catalog = await ensureSlashCommandCatalog(
      Object.values(data.workspaces)
        .map((w) => ({ workspaceId: w.id, rootDir: w.trees[0]?.rootDir ?? '' }))
        .filter((r) => r.rootDir),
      agent === 'codex' ? 'codex' : 'claude',
    )
    if (!catalog) return []
    return [...catalog.global, ...(catalog.workspaces[workspaceId] ?? [])]
  },
)

/**
 * Land a composer attachment on disk and hand back its path. The phone uploads
 * its screenshots to Convex storage and the bridge downloads them here; on the
 * desktop the bytes are already local, so the round trip collapses to this —
 * same directory, same pruning, so a picked image is typed into the TUI exactly
 * the way a phone-sent one is.
 */
ipcMain.handle('chat-save-image', async (_event, bytes: Uint8Array, mime: string) => {
  return saveRemoteImage(new Uint8Array(bytes), typeof mime === 'string' ? mime : 'image/png')
})

/**
 * A paced key sequence (model/effort switch, question-form answer). Replayed
 * here rather than with setTimeouts in the renderer for the same reason the
 * bridge replays the phone's: claude's slash handling has a real timing window,
 * and conditional steps need to read the live screen — which the composer
 * cannot see. Sanitized despite the sender being our own renderer: the clamps
 * are what stop a malformed protocol from typing a wall of text into a TUI.
 */
ipcMain.handle('chat-key-steps', async (_event, sessionId: string, steps: unknown) => {
  const sanitized = sanitizeKeySteps(steps)
  if (!sanitized) throw new Error('Invalid chat control sequence')
  const daemon = getDaemonClient()
  await chatInputController.run(sessionId, (check) => runKeySteps(
    guardedChatInput({
      write: (data) => { assertChatSessionWritable(sessionId); daemon.write(sessionId, data) },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      readScreen: () => getTerminalBufferText(sessionId),
    }, check),
    sanitized,
  ))
  agentIdleReaper?.noteActivity(sessionId)
  return true
})

ipcMain.handle('chat-interrupt', (_event, sessionId: string) => {
  if (nativeChatSnapshot(sessionId)) return executeNativeChat(sessionId, { kind: 'interrupt' })
  chatInputController.cancel(sessionId)
  assertChatSessionWritable(sessionId)
  getDaemonClient().write(sessionId, '\x1b')
  agentIdleReaper?.noteActivity(sessionId)
  return undefined
})

/**
 * Clear the TUI's input line, paste the message, and submit it — each step
 * waiting for the terminal to fall silent first. A blind 150ms CR races the
 * TUI whenever the paste carries an image path (it stops to read and encode the
 * file), which silently swallowed the send. See remote-bridge-chat-send.ts.
 */
ipcMain.handle(
  'chat-submit',
  async (_event, sessionId: string, body: string, opts?: { steer?: boolean; before?: unknown }) => {
    if (nativeChatSnapshot(sessionId)) throw new Error('Use native chat submission for this session')
    if (typeof body !== 'string' || !body.trim()) throw new Error('Message is empty')
    const before = opts?.before === undefined ? null : sanitizeKeySteps(opts.before)
    if (opts?.before !== undefined && !before) throw new Error('Invalid chat routing sequence')
    const daemon = getDaemonClient()
    if (opts?.steer) chatInputController.cancel(sessionId)
    await chatInputController.run(sessionId, async (check) => {
      const deps = guardedChatInput({
        write: (data: string) => { assertChatSessionWritable(sessionId); daemon.write(sessionId, data) },
        isQuiet: (quietMs) => !hasRecentTerminalOutput(sessionId, quietMs || QUIET_MS),
        sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
        readScreen: () => getTerminalBufferText(sessionId),
      }, check)
      if (before) await runKeySteps(deps, before)
      await submitChatMessage(deps, body, { steer: opts?.steer === true })
    })
    agentIdleReaper?.noteActivity(sessionId)
  },
)

// Push appends/clears at the renderer as they happen, so the pane tails without
// polling. Subscribed once at module load; the window is looked up per event
// because it is recreated on macOS re-activate.
agentChatLog.subscribe((event) => {
  mainWindow?.webContents.send('chat-log-event', event)
})

ipcMain.handle('get-mobile-access', async () => {
  return resolveMobileAccess()
})

ipcMain.handle('mobile-access-publish', async () => {
  return publishMobileAccess()
})

ipcMain.handle('mobile-access-unpublish', async () => {
  return unpublishMobileAccess()
})

// Brings the Tailscale app forward to sign in or connect. Falls back to the
// download page when it is not installed at all.
ipcMain.handle('mobile-access-open-tailscale', async () => {
  if (!findTailscale()) {
    await shell.openExternal(TAILSCALE_DOWNLOAD_URL)
    return { success: true }
  }
  const error = await shell.openPath('/Applications/Tailscale.app')
  if (error) {
    await shell.openExternal(TAILSCALE_DOWNLOAD_URL)
    return { success: false, error }
  }
  return { success: true }
})

// Issue board reads/writes, backed by the durable store the phone shares.
registerIssueBoardIpc()

// Notification summaries and webhook filters use the OpenRouter key saved in
// Settings — the same one the idle notifier classifies with.
setOpenRouterKeyProvider(() => {
  const encrypted = loadPersistedData().settings?.openRouter?.encryptedApiKey
  return encrypted ? decryptStringFromStorage(encrypted) : undefined
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
  remoteBridgeOnStatePersisted(loadPersistedData())
  try {
    syncRepositoryWorkspaceSettings(data.workspaces, previousData.workspaces)
  } catch (error) {
    console.error('[main] Failed to sync repository workspace settings:', error)
  }
})

// Realtime mirror channel: the renderer sends this on a throttle the moment its
// store changes, separate from the debounced 'save-state' disk write above, so
// phone/web clients track the desktop within ~one frame. No disk I/O here — it
// only forwards the fresh state to the remote bridge.
ipcMain.on('mirror-state', (_, data) => {
  remoteBridgeOnMirror(data)
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

// Recent Claude/Codex sessions read off their own transcript files, so a
// session closed by accident can be resumed from the top bar.
ipcMain.handle(
  'agent-sessions-recent',
  async (_, opts?: { limit?: number; maxAgeDays?: number }) => {
    try {
      return await listRecentAgentSessions(opts)
    } catch (err) {
      console.error('[main] failed to list recent agent sessions:', (err as Error).message)
      return []
    }
  },
)

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
    const sessions = (await listLiveSessionStatuses(getDaemonClient())).map(session => ({ ...session, status: nativeChatSnapshot(session.sessionId)?.provider ?? session.status }))
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

// Rename the tree's current branch (used after generating a Linear ticket, to
// embed the new identifier so branch-based linking picks it up everywhere).
ipcMain.handle('rename-git-branch', (_, cwd: string, newName: string) => {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    execFile('git', ['branch', '-m', newName], { cwd }, (err, _stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message).trim() })
      resolve({ ok: true })
    })
  })
})

// Run a one-shot headless Claude agent in a worktree and return its text output
// (used to draft a Linear ticket from the work in progress).
ipcMain.handle('run-headless-agent', (_, cwd: string, prompt: string) => {
  return runHeadlessAgent(cwd, prompt)
})

// Goes through the shared cache in pr-mirror so this poll doubles as the state
// mirror's refresh — the phone's sidebar shows the same badge without a second
// `gh` poller of its own.
ipcMain.handle('get-git-pr-info', (_, cwd: string, branch: string) => {
  return getPullRequest(cwd, branch)
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

/**
 * Point-in-time recovery: snapshot branch/sha, uncommitted changes, untracked
 * files, and the tree's session records before anything is destroyed. Fired on
 * its own — ahead of destruction scripts and the store update — so the snapshot
 * captures the tree as the user last saw it. Best-effort: a backup failure is
 * logged, never surfaced, and never blocks the removal that follows.
 */
ipcMain.handle('backup-worktree', async (_, mainRepoDir: string, worktreeDir: string) => {
  // Read the session records synchronously, before the renderer's debounced
  // save can drop the ones it just removed from the store.
  const sessions = sessionsUnderDir(loadPersistedData().sessions ?? {}, worktreeDir)
  try {
    const backupId = await backupWorktree({ mainRepoDir, worktreeDir, reason: 'delete', sessions })
    if (backupId) console.log(`[backup] worktree backed up as ${backupId}`)
    return { backupId }
  } catch (err) {
    console.error('[backup] worktree backup failed:', err)
    return { backupId: null }
  }
})

ipcMain.handle(
  'remove-worktree',
  async (_, mainRepoDir: string, worktreeDir: string, options?: { skipBackup?: boolean }) => {
    // Callers that snapshot on their own (the optimistic delete paths, which
    // back up before running destruction scripts) pass skipBackup.
    if (!options?.skipBackup) {
      try {
        const backupId = await backupWorktree({
          mainRepoDir,
          worktreeDir,
          reason: 'delete',
          sessions: sessionsUnderDir(loadPersistedData().sessions ?? {}, worktreeDir),
        })
        if (backupId) console.log(`[backup] worktree backed up as ${backupId}`)
      } catch (err) {
        console.error('[backup] worktree backup failed:', err)
      }
    }

    // Queue *before* attempting: the caller already dropped the tree from the
    // UI, so an app quit (or crash) mid-removal would otherwise strand the
    // directory with nobody left to finish the job. The entry is cleared as
    // soon as the removal lands.
    enqueuePendingDeletion({ mainRepoDir, worktreeDir })
    const result = await removeWorktreeFromDisk(mainRepoDir, worktreeDir)
    if (result.success) {
      dropPendingDeletion(worktreeDir)
    } else {
      console.warn(`[worktree] removal of ${worktreeDir} failed, queued for retry: ${result.error}`)
      enqueuePendingDeletion({ mainRepoDir, worktreeDir, lastError: result.error })
    }
    return { success: result.success, error: result.error }
  },
)

ipcMain.handle('list-worktree-backups', (_, mainRepoDir?: string) => {
  return listWorktreeBackups(mainRepoDir)
})

ipcMain.handle('restore-worktree-backup', (_, backupId: string) => {
  return restoreWorktreeBackup(backupId)
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

ipcMain.handle('kill-running-server', async (_event, pid: number, port: number) => {
  return killRunningServer(pid, port)
})

ipcMain.handle('open-external-url', async (_event, url: string) => {
  // Renderer-supplied string: only hand the OS schemes a dev server can
  // legitimately produce, so a stray row can never launch a file:// or a
  // custom handler.
  const allowed = /^(https?|exp):\/\//i
  if (typeof url !== 'string' || !allowed.test(url)) {
    return { success: false, error: 'Unsupported URL scheme' }
  }
  try {
    await shell.openExternal(url)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('get-running-servers', async () => {
  try {
    const sessions = await getDaemonClient().listSessions()
    const sessionPidToId = new Map<number, string>()
    for (const session of sessions) {
      if (session.isAlive && session.pid) sessionPidToId.set(session.pid, session.sessionId)
    }
    return await scanRunningServers(sessionPidToId)
  } catch {
    return []
  }
})

registerLinearSafeStorage(ipcMain)

ipcMain.handle('openrouter:list-models', async (_event, apiKey?: string) => {
  const headers: Record<string, string> = {}
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`

  const response = await fetch('https://openrouter.ai/api/v1/models', { headers })
  if (!response.ok) {
    throw new Error(`OpenRouter models request failed with HTTP ${response.status}`)
  }

  const payload = await response.json() as {
    data?: Array<{ id?: unknown; name?: unknown }>
  }

  return (payload.data ?? [])
    .filter((model): model is { id: string; name?: string } => typeof model.id === 'string')
    .map((model) => ({
      id: model.id,
      name: typeof model.name === 'string' && model.name.trim() ? model.name : model.id,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
})

// ─── Voice IPC ──────────────────────────────────────────────────────────────

function ensureVoiceSetup(): VoiceSetup {
  if (voiceSetup) return voiceSetup
  const setup = new VoiceSetup()
  setup.on('progress', (event: VoiceSetupProgressEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('voice:setupProgress', event)
    }
  })
  voiceSetup = setup
  return setup
}

function ensureVoiceManager(): VoiceManager {
  if (voiceManager) return voiceManager
  const mgr = new VoiceManager({
    spawn: (opts) => spawnPythonSidecar(opts),
    requireReady: () => ensureVoiceSetup().isReady(),
    sidecarOptions: voiceSettings
      ? {
          // Normalize defensively so legacy persisted values like 'computer'
          // (an invalid openWakeWord prebuilt) get coerced to the default
          // before the sidecar tries to load the model and crashes.
          wakeWord: normalizeVoiceWakeWord(voiceSettings.wakeWord),
          wakeThreshold: voiceSettings.wakeWordThreshold,
          intentThreshold: voiceSettings.intentConfidenceThreshold,
        }
      : {},
  })
  mgr.on('event', (event: VoiceEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('voice:event', event)
    }
  })
  mgr.on('status', (status: VoiceStatus) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('voice:status', status)
    }
  })
  voiceManager = mgr
  return mgr
}

ipcMain.handle('voice:enable', async () => {
  const setup = ensureVoiceSetup()
  if (!setup.isReady()) {
    // Don't spawn the sidecar — we'd just hit `sidecar_failed_to_spawn`.
    // The renderer drives setup via voice:runSetup, then re-calls voice:enable.
    return { success: false, needsSetup: true, setupStatus: setup.getStatus() }
  }

  // Trigger the macOS microphone permission prompt explicitly. Relying on the
  // Python sidecar to open the mic doesn't work in dev mode — Electron's
  // bundled binary lacks NSMicrophoneUsageDescription, so macOS silently
  // denies and the sidecar dies before emitting anything to stderr.
  if (process.platform === 'darwin') {
    try {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      if (!granted) {
        return {
          success: false,
          error: 'mic_denied',
          message: 'Microphone access denied. Open System Settings → Privacy & Security → Microphone and grant access to Orchestra (or Electron in dev mode), then try again.',
        }
      }
    } catch (err) {
      // Don't block enable on a permissions API failure — let the sidecar try.
      console.warn('[voice] askForMediaAccess threw:', err)
    }
  }

  try {
    await ensureVoiceManager().enable()
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('voice:checkSetup', async (): Promise<VoiceSetupStatus> => {
  return ensureVoiceSetup().getStatus()
})

ipcMain.handle('voice:runSetup', async (_event, opts: { installPython?: boolean } = {}) => {
  return ensureVoiceSetup().runSetup(opts)
})

ipcMain.handle('voice:getIntroSeen', async () => {
  return loadVoiceIntroSeen()
})

ipcMain.handle('voice:markIntroSeen', async () => {
  saveVoiceIntroSeen(true)
})

ipcMain.handle('voice:getSetupAttempted', async () => {
  return loadVoiceSetupAttempted()
})

ipcMain.handle('voice:setSetupAttempted', async (_event, attempted: boolean) => {
  saveVoiceSetupAttempted(!!attempted)
})

ipcMain.handle('voice:getSetupCardDismissed', async () => {
  return loadVoiceSetupCardDismissed()
})

ipcMain.handle('voice:setSetupCardDismissed', async (_event, dismissed: boolean) => {
  saveVoiceSetupCardDismissed(!!dismissed)
})

ipcMain.handle('voice:disable', async () => {
  voiceManager?.disable()
})

ipcMain.on('voice:setVocabulary', (_event, vocab: VoiceVocabularyEntry[]) => {
  ensureVoiceManager().setVocabulary(vocab)
})

ipcMain.handle('voice:updateSettings', async (_event, settings: VoiceSettings) => {
  voiceSettings = settings
  // We deliberately do NOT auto-restart the sidecar to apply new wake-word /
  // threshold settings — disable + re-enable is the explicit path. We only
  // record the settings so the next spawn picks them up.
})

ipcMain.handle('voice:getStatus', async () => {
  return voiceManager?.getStatus() ?? ({ enabled: false, state: 'disabled' } satisfies VoiceStatus)
})

ipcMain.handle('voice:getLogs', async () => {
  return voiceManager?.getStderrSnapshot() ?? []
})

// App lifecycle
if (hasSingleInstanceLock) {
  app.whenReady().then(createWindow)
}

app.on('window-all-closed', () => {
  stopUpdater()
  stopUsageManager()
  agentSleepBlocker?.stop()
  agentSleepBlocker = null
  codexNotifyListener?.stop()
  codexNotifyListener = null
  codexRolloutWatcher?.stop()
  codexRolloutWatcher = null
  codexHookPort = null
  voiceManager?.disable()
  voiceManager = null
  app.quit()
})
