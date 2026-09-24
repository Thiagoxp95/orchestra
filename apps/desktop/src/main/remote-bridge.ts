// Always-on bridge between the desktop and the phone. Publishes sanitized
// workspace/session state into the local server's state mirror (which the web
// app subscribes to over /api/sync) and applies the commands the phone sends
// back. Terminal bytes take their own path: TerminalStreamHost dials the relay
// on the same local server, and the phone's xterm attaches there as a viewer.
//
// Everything here used to round-trip through a Convex deployment. It is now
// one process talking to itself, so the state push is a function call, the
// command loop is a callback, and the watchdogs that guarded a cloud socket
// against wedging are gone with the socket.

import { powerMonitor, powerSaveBlocker, type BrowserWindow } from 'electron'
import { TerminalStreamHost } from './terminal-stream-host'
import { geometryForDesktopRequest } from './remote-bridge-geometry'
import { nativeChatActive, nativeChatManager, stopNativeChat } from './native-chat/service'
import { invalidateNativeChat } from './local-server/runtime-state'
import { getLocalServer } from './local-server'
import { setCommandHandler, type RemoteCommand } from './local-server/api'
import * as remoteState from './local-server/runtime-state'
import { releaseUpload, resolveUpload } from './local-server/uploads'
import { isChatInput, isChatInterrupt } from '../shared/chat-command-queue'
import { getDaemonClient } from './daemon-client'
import { loadPersistedData } from './persistence'
import { sanitizeWorkspaces, buildSessionMap } from './remote-bridge-sanitize'
import { resolveLinearIssues, getCachedLinearIssue } from './linear-mirror'
import { getCachedPullRequest, setPullRequestChangeListener } from './pr-mirror'
import { generateTicketDraft, createLinearTicket } from './ticket-orchestrator'
import { normalizeCreateWorktreePayload } from './remote-bridge-create-worktree'
import { normalizeSpawnInTreePayload } from './remote-bridge-spawn-in-tree'
import {
  normalizeSendImagePayload,
  normalizeSendChatMessagePayload,
  pruneRemoteImages,
} from './remote-bridge-image'
import {
  normalizeResumeSessionPayload,
  toRemoteAgentSessions,
} from './remote-bridge-agent-sessions'
import { listRecentAgentSessions } from './agent-session-history'
import { createLatestPublisher } from './remote-bridge-publisher'
import { runKeySteps, sanitizeKeySteps } from './remote-bridge-key-steps'
import { chatInputController, guardedChatInput } from './chat-input-controller'
import {
  initialOwnership,
  claimWeb,
  reclaimDesktop,
  overlaySessionGeometry,
  planDesktopRestore,
  type Geometry,
  type GeometryOwnership,
} from './remote-bridge-geometry'
import { PtyLiveness } from './pty-liveness'
import { buildLiveStatus } from './remote-bridge-livestatus'
import {
  AgentContextTracker,
  type AgentContextSnapshot,
  type TrackedAgentSession,
} from './agent-context-tracker'
import { SessionResumeTracker, type ResumeTrackedSession, type SessionResumePairing } from './session-resume-tracker'
import { isResumableAgent } from './agent-resume-ids'
import { AgentMessageMirror } from './remote-bridge-messages'
import { agentChatLog } from './agent-chat-log'
import { findClaudeTranscriptById, parseClaudeResumeId } from './resume-transcript'
import {
  getLastOutputAtBySession,
  getTerminalBufferText,
  hasRecentTerminalOutput,
} from './terminal-output-buffer'
import {
  submitChatMessage,
  typeImagePath,
  type ChatSendDeps,
} from './remote-bridge-chat-send'
import { deliverAfterResume } from './remote-bridge-resume-send'
import { detectTuiPrompt } from './tui-prompt-detector'
import { getSlashCommandCatalog, refreshSlashCommandCatalog } from './remote-bridge-commands'
import { killRunningServer } from './running-servers'
import { getServerCatalog, refreshServerCatalog, resetServerCatalog } from './remote-bridge-servers'
import { sanitizeUsage, usageFingerprint, type MirroredUsage } from './remote-bridge-usage'
import { updateFingerprint } from './remote-bridge-update'
import { getMirroredUpdate, requestRestartToUpdate, setUpdateStatusListener } from './updater'
import type { PersistedData, UsageSnapshot } from '../shared/types'

// Pushes are otherwise change-triggered: if the last push after a close/exit
// is dropped (app slept before the persist debounce flushed), the phone keeps
// the stale session list until some unrelated change pushes again. A periodic
// reconciliation push guarantees the latest state always lands within one
// interval — and it is what advances the mirror's `updatedAt`, which the
// phone's "desktop offline" banner keys off. We also reconcile immediately
// when the desktop regains focus or wakes from sleep.
const HEARTBEAT_MS = 10_000

let started = false

// macOS App Nap. With the window behind something else and no user events
// arriving, the OS throttles this process's timers and sockets — the heartbeat
// and the local server's delivery all stall together, and the phone's spawns
// pile up until the mouse crosses the window (that event is what ends the nap;
// 2026-08-16: "all the sessions I tried to open opened at once the moment I
// moved the mouse over the desktop"). The bridge exists to serve a phone that
// is by definition used while the desktop is idle, so keep the process awake
// for as long as the bridge runs.
let appSuspensionBlocker: number | null = null
// Renderer handle, used to forward remote action triggers (runAction lives in
// the renderer store, mirroring the webhook-run-action path).
let mainWindow: BrowserWindow | null = null

// Live status overlaid on the mirrored state.
const liveStatus: Record<string, { work: 'idle' | 'working'; exited?: boolean; label?: string }> = {}

// Sessions whose transcript the message mirror has actually read — the ones with
// a conversation both clients can show. Kept here (rather than asked of the
// mirror on demand) so a pairing that lands between pushes can trigger one, and
// so the desktop renderer can be told without polling.
const chatReady = new Set<string>()
let chatReadyListener: ((sessionIds: string[]) => void) | null = null

function emitChatReady(): void {
  chatReadyListener?.([...chatReady])
  pushState()
}

/** Sessions with a readable conversation right now — the desktop renderer's
 *  initial read, before the first push event. */
export function getChatReadySessions(): string[] {
  return [...chatReady]
}

/**
 * The same verdict for the phone, as one entry per AGENT session — a `false`
 * where the pairing hasn't landed, nothing at all for shells. The web needs the
 * explicit false to tell "no conversation here" apart from "desktop too old to
 * publish this at all", where it keeps the chat view rather than losing it.
 */
function chatReadyByAgent(sessions: Record<string, { processStatus: string }>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [id, s] of Object.entries(sessions)) {
    if (s.processStatus !== 'claude' && s.processStatus !== 'codex') continue
    out[id] = chatReady.has(id)
  }
  return out
}

/** The desktop renderer's subscription to the set above (see index.ts). */
export function remoteBridgeOnChatReady(listener: (sessionIds: string[]) => void): void {
  chatReadyListener = listener
}

// Current desktop PTY geometry per session, fed by the desktop's resize taps
// (see remoteBridgeOnResize). Merged into the mirrored sessions so the phone can
// size its xterm to the desktop's width and scale the font to fit — instead of
// resizing the shared PTY itself, which would fight the desktop's ResizeObserver
// and desync the mirror.
const liveGeometry: Record<string, { cols: number; rows: number }> = {}

// ── Geometry ownership ────────────────────────────────────────────────────
// Which client currently drives the single shared PTY size. The transitions are
// a pure reducer (see remote-bridge-geometry.ts); this holds the one value and
// wires each change to the daemon/renderer/mirror side effects.
let ownership: GeometryOwnership = initialOwnership()

// Per-session desktop geometry as it was the moment the phone took over, kept so
// a reclaim can put every PTY back to the size the desktop was actually driving.
// Captured on the desktop -> web edge only: a phone re-claiming at a new viewport
// must not overwrite it with phone sizes.
let preClaimGeometry: Record<string, Geometry> | null = null

function isSaneDim(cols: number, rows: number): boolean {
  return Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0
}

// Writes into an agent TUI are paced against the terminal falling silent rather
// than by a fixed delay — see remote-bridge-chat-send.ts for why (a blind delay
// races the TUI reading a pasted image off disk, and the message is silently
// swallowed or glued onto whatever was already in the composer).
function chatSendDeps(sessionId: string, check: () => void = () => {}): ChatSendDeps {
  const daemon = getDaemonClient()
  return {
    write: (data) => { check(); daemon.write(sessionId, data) },
    isQuiet: (quietMs) => !hasRecentTerminalOutput(sessionId, quietMs),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}

// Resize EVERY open session's PTY to (cols, rows) and record it as their live
// geometry so the next mirror push reflects it. Used by both claim paths (web
// focus and desktop reclaim) to honor the "resize all open sessions" model.
async function resizeAllSessions(cols: number, rows: number): Promise<void> {
  const daemon = getDaemonClient()
  const ids = Object.keys(loadPersistedData().sessions)
  for (const id of ids) {
    liveGeometry[id] = { cols, rows }
    try {
      await daemon.resize(id, cols, rows)
    } catch (err) {
      console.error('[remote-bridge] resizeAllSessions failed', id, err)
    }
  }
}

/**
 * A focused web/phone claims geometry ownership. Resize every open PTY to the
 * phone's viewport and flip ownership so the desktop stops auto-fitting (and
 * starts scaling to view). The phone's viewer follows the reflow through the
 * live terminal stream.
 */
async function claimGeometryWeb(cols: number, rows: number): Promise<void> {
  if (!started) return
  const { state, changed } = claimWeb(ownership, cols, rows)
  if (!changed) return
  if (ownership.owner === 'desktop') preClaimGeometry = { ...liveGeometry }
  ownership = state
  await resizeAllSessions(cols, rows)
  // Tell the desktop renderer to stop driving the PTY and scale to view instead.
  mainWindow?.webContents.send('remote-geometry-owner', {
    owner: 'web', cols, rows, epoch: ownership.epoch,
  })
  pushState()
}

/**
 * The desktop reclaims geometry ownership (user clicked anywhere in the app on
 * the computer). Flip ownership back so the desktop's autofit drives the PTY
 * again and the phone returns to scaling-viewer mode, and eagerly resize EVERY
 * open PTY back off the phone's viewport — symmetric with the web claim, which
 * resized them all on the way in. Sizes come from the snapshot taken at claim
 * time, per session; the renderer's own geometry (the active terminal's) covers
 * anything the snapshot missed. The phone viewer follows the reflow through the
 * live stream, so no explicit re-seed is needed.
 */
export async function remoteBridgeReclaimDesktop(cols?: number, rows?: number, sessionId?: string): Promise<void> {
  if (!started) return
  const activeId = sessionId ?? getMirrorSnapshot().activeSessionId
  if (activeId) terminalStreamHost?.reclaim(activeId)
  const { state, changed } = reclaimDesktop(ownership)
  if (!changed) return
  ownership = state
  const fallback =
    typeof cols === 'number' && typeof rows === 'number' && isSaneDim(cols, rows)
      ? { cols, rows }
      : null
  const snapshot = preClaimGeometry ?? {}
  preClaimGeometry = null
  const daemon = getDaemonClient()
  for (const step of planDesktopRestore(Object.keys(loadPersistedData().sessions), snapshot, fallback)) {
    liveGeometry[step.sessionId] = { cols: step.cols, rows: step.rows }
    try {
      await daemon.resize(step.sessionId, step.cols, step.rows)
    } catch (err) {
      console.error('[remote-bridge] desktop restore resize failed', step.sessionId, err)
    }
  }
  mainWindow?.webContents.send('remote-geometry-owner', { owner: 'desktop', epoch: ownership.epoch })
  pushState()
}

// Terminal delivery to phone viewers, through the local server's relay.
let terminalStreamHost: TerminalStreamHost | null = null
const statePublisher = createLatestPublisher<MirrorPayload | undefined>(publishState)

// Reconciliation: periodic heartbeat + wake/focus listeners (registered in
// startRemoteBridge, torn down in stopRemoteBridge).
let heartbeat: ReturnType<typeof setInterval> | null = null
const reconcile = (): void => { pushState() }

// PTY-liveness poll: which mirrored sessions still have a PTY in the daemon.
// A daemon restart kills every PTY while the store keeps the sessions, and
// daemon.write() is fire-and-forget — so without this, anything the phone types
// into such a corpse vanishes with no error anywhere (see pty-liveness.ts).
const ptyLiveness = new PtyLiveness()
let ptyLivenessTimer: ReturnType<typeof setInterval> | null = null
const PTY_LIVENESS_POLL_MS = 5_000

async function pollPtyLiveness(): Promise<void> {
  let daemonSessions: Awaited<ReturnType<ReturnType<typeof getDaemonClient>['listSessions']>>
  try {
    daemonSessions = await getDaemonClient().listSessions()
  } catch {
    // Transient daemon-socket loss is signal loss, not evidence the agents died.
    return
  }
  const storeIds = Object.keys(getMirrorSnapshot().sessions)
  const changed = ptyLiveness.update(daemonSessions, storeIds, Date.now())
  if (changed.length === 0) return
  for (const id of changed) {
    if (ptyLiveness.isDead(id)) {
      // Same shape the daemon's own exit event produces — the web already
      // renders it (greyed row, "Exited" badge, gated chat composer).
      liveStatus[id] = { ...liveStatus[id], work: 'idle', exited: true }
    } else if (liveStatus[id]?.exited) {
      // The desktop reopened the session (createOrAttach respawned a shell):
      // the exited verdict no longer holds. This also heals the pre-existing
      // stale flag from the exit-event path, which never cleared it.
      const { exited: _exited, ...rest } = liveStatus[id]
      liveStatus[id] = rest
    }
  }
  emitExitedSessions()
  pushState()
}

/**
 * Sessions whose PTY is confirmed gone. The desktop needs the same verdict the
 * phone already renders — it decides which rows offer to resume themselves —
 * and deriving it a second time in the renderer would be a second thing to keep
 * true. Includes the exit-event path's verdicts, not just the poll's.
 */
export function getExitedSessions(): string[] {
  return Object.entries(liveStatus)
    .filter(([, status]) => status.exited)
    .map(([sessionId]) => sessionId)
}

let exitedSessionsListener: ((sessionIds: string[]) => void) | null = null

export function remoteBridgeOnExitedSessions(listener: (sessionIds: string[]) => void): void {
  exitedSessionsListener = listener
}

function emitExitedSessions(): void {
  exitedSessionsListener?.(getExitedSessions())
}

// Focus path: push the latest state, since a change-triggered push is most
// likely to have been missed while the window was in the background.
const onFocus = (): void => {
  reconcile()
}

// Wake path (resume / unlock): everything onFocus does, plus a fresh relay
// socket for the terminal host. Sleep can strand an apparently open socket,
// and a phone viewer would otherwise stay frozen on its last pre-sleep frame.
const onWake = (): void => {
  terminalStreamHost?.resume()
  onFocus()
}

/** True once startRemoteBridge has run: the phone can be served. */
export function isRemoteBridgeEnabled(): boolean {
  return started
}

/** Force an immediate state mirror push (e.g. after a branch rename changes a
 *  worktree's linked Linear ticket, so the web's icon updates without waiting
 *  for the next heartbeat). No-op before the bridge starts. */
export function remoteBridgeForcePush(): void {
  pushState()
}

// ── Chat Stop ordering ────────────────────────────────────────────────────
// A Stop from the phone's chat composer must reach the agent immediately, and
// any chat send received BEFORE the Stop but not yet applied must be dropped:
// the user stopped the turn it was queued behind, and typing it afterwards would
// start a new one. Stops bypass the server's command chain (see api.ts), so this
// map is the only ordering between the two paths.
const chatStoppedAt = new Map<string, number>()

const isInterrupt = (cmd: RemoteCommand): boolean => isChatInterrupt(cmd)
const isInput = (cmd: RemoteCommand): boolean => isChatInput(cmd)

function interruptChat(sessionId: string): void {
  chatInputController.cancel(sessionId)
  assertChatSessionWritable(sessionId)
  getDaemonClient().write(sessionId, '\x1b')
  acknowledgeRemoteAttention(sessionId)
}

async function handleCommand(cmd: RemoteCommand): Promise<void> {
  if (isInterrupt(cmd)) {
    if (cmd.sessionId) {
      chatStoppedAt.set(cmd.sessionId, Math.max(chatStoppedAt.get(cmd.sessionId) ?? 0, cmd.receivedAt))
      interruptChat(cmd.sessionId)
    }
    return
  }
  if (isInput(cmd) && cmd.sessionId && (chatStoppedAt.get(cmd.sessionId) ?? -1) >= cmd.receivedAt) {
    console.log('[remote-bridge] dropping chat input stopped before it ran', cmd.kind, cmd.sessionId.slice(0, 8))
    return
  }
  await applyOne(cmd)
}

export function startRemoteBridge(window: BrowserWindow): void {
  mainWindow = window
  const server = getLocalServer()
  if (!server) {
    console.error('[remote-bridge] local server is not running — phone access disabled')
    return
  }
  started = true

  terminalStreamHost?.dispose()
  terminalStreamHost = new TerminalStreamHost({
    daemon: getDaemonClient(),
    secret: server.hostSecret,
    endpoint: `ws://127.0.0.1:${server.port}`,
    onGeometry(sessionId, geometry, epoch) {
      if (geometry) liveGeometry[sessionId] = geometry
      mainWindow?.webContents.send('remote-geometry-owner', {
        sessionId, owner: geometry ? 'web' : 'desktop', ...geometry, epoch,
      })
      pushState()
    },
  })

  // Status taps → liveStatus + push.
  getDaemonClient().addClaudeWorkStateHandler((sessionId, state) => {
    liveStatus[sessionId] = {
      ...liveStatus[sessionId],
      work: state === 'idle' ? 'idle' : 'working',
    }
    pushState()
  })
  getDaemonClient().addTerminalExitHandler((sessionId) => {
    liveStatus[sessionId] = { ...liveStatus[sessionId], work: 'idle', exited: true }
    emitExitedSessions()
    delete liveGeometry[sessionId]
    pushState()
  })

  // Auto-update state → mirror. The phone's "Restart & update" button reads it,
  // so it must follow the desktop within a frame rather than on the heartbeat.
  setUpdateStatusListener(onUpdateStatusChanged)

  // A worktree's PR opened / merged / closed (the desktop sidebar's poll refreshed
  // the shared cache): re-push so the phone's badge follows within a frame instead
  // of on the next heartbeat.
  setPullRequestChangeListener(() => pushState())

  // Every timer below is only as reliable as the process's right to run them.
  if (appSuspensionBlocker === null || !powerSaveBlocker.isStarted(appSuspensionBlocker)) {
    appSuspensionBlocker = powerSaveBlocker.start('prevent-app-suspension')
  }

  // Command loop: the local server hands each phone command here, serialized.
  setCommandHandler(handleCommand, { immediate: isInterrupt })

  // Reconcile the mirror whenever a change-triggered push might have been
  // missed: on a fixed heartbeat, when the window regains focus, and when the
  // machine wakes from sleep / unlocks.
  heartbeat = setInterval(reconcile, HEARTBEAT_MS)
  // Keep the mirror honest about which sessions still have a PTY behind them.
  ptyLivenessTimer = setInterval(() => void pollPtyLiveness(), PTY_LIVENESS_POLL_MS)
  window.on('focus', onFocus)
  powerMonitor.on('resume', onWake)
  powerMonitor.on('unlock-screen', onWake)

  // Initial state push.
  pushState()
  // Sweep remote-image files left by previous runs (best-effort, off the
  // critical path).
  void pruneRemoteImages()
  console.log('[remote-bridge] started')
}

export function stopRemoteBridge(): void {
  started = false
  statePublisher.reset()
  setCommandHandler(null)
  terminalStreamHost?.dispose()
  terminalStreamHost = null
  setUpdateStatusListener(null)
  if (appSuspensionBlocker !== null) {
    if (powerSaveBlocker.isStarted(appSuspensionBlocker)) powerSaveBlocker.stop(appSuspensionBlocker)
    appSuspensionBlocker = null
  }
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
  if (ptyLivenessTimer) {
    clearInterval(ptyLivenessTimer)
    ptyLivenessTimer = null
  }
  mainWindow?.off('focus', onFocus)
  powerMonitor.off('resume', onWake)
  powerMonitor.off('unlock-screen', onWake)
  remoteState.clearRemoteState()
}

export function remoteBridgeOnStatePersisted(_data: PersistedData): void {
  pushState()
}

// Just the slice of persisted state the mirror needs. The renderer sends this on
// a throttle (App.tsx) the moment the store changes, so it arrives BEFORE the
// debounced disk write — pushState must mirror from it directly, not from
// loadPersistedData() which may still hold the pre-change (stale) copy.
type MirrorData = Pick<PersistedData, 'workspaces' | 'sessions' | 'activeWorkspaceId' | 'activeSessionId'>

// The realtime mirror also carries the renderer's authoritative per-session work
// state (computeAgentView over the full store), which the sparse daemon-tap
// liveStatus can't supply. Optional because the disk/heartbeat callers don't have
// it — they reuse the last value cached in rendererWorkState.
type MirrorPayload = MirrorData & {
  workState?: Record<string, 'idle' | 'working'>
  attention?: Record<string, 'input' | 'approval'>
}

// Last per-session work state the renderer computed (the same signal the desktop
// sidebar shimmers from). Cached so the heartbeat / focus / wake / status-tap
// pushes — which have no payload — still emit the full work state instead of the
// daemon tap's transition-only subset. See remote-bridge-livestatus.ts.
let rendererWorkState: Record<string, 'idle' | 'working'> = {}

// Last per-session attention state the renderer computed (waiting for reply /
// approval). Cached alongside rendererWorkState so payload-less pushes still
// carry it. Feeds the web's workspace-level "needs input" count.
let rendererAttention: Record<string, 'input' | 'approval'> = {}

// Last authoritative store snapshot the renderer pushed. The disk copy
// (loadPersistedData) lags behind this — its 1s debounce is starved by an
// agent-boot update storm, so a freshly-spawned session's tree membership can be
// missing from disk for a while. Main-side consumers that need the *current*
// session/worktree topology (e.g. the Linear ticket orchestrator) must read this,
// not disk, or they'll fail to resolve a session the web can plainly see.
let lastMirror: MirrorData | null = null

// Last compacted usage payload, mirrored on every push so a phone that connects
// between probes still gets the numbers. Kept here (not read from usage-manager)
// so pushState stays synchronous and payload-less callers carry it too.
let lastUsage: MirroredUsage | null = null
let lastUsageKey = ''

// Per-session context-window occupancy, for the phone's session overview. Owned
// here rather than in index.ts because pushState is the only consumer and the
// tracked set is exactly the agent sessions pushState already walks; the tracker
// re-pushes on its own when a transcript moves.
let contextTracker: AgentContextTracker | null = null

// Structured chat mirror: tails the same agent sessions' transcripts and parses
// them into ChatMessages for the desktop's chat view (agent-chat-log.ts). Shares
// the tracker's lifecycle (created on first push, re-aimed on every push) and
// its transcript resolution.
let messageMirror: AgentMessageMirror | null = null

// Which conversation each agent pane is holding, so a pane whose process died
// (most often: the machine rebooted) can offer to reopen its own conversation
// instead of launching a fresh agent. Reported to the renderer, which persists
// it on the session row — see sessionResumePairingListener.
let resumeTracker: SessionResumeTracker | null = null
let resumePairingListener: ((sessionId: string, pairing: SessionResumePairing) => void) | null = null

/**
 * Subscribe to conversation pairings. index.ts forwards these to the renderer,
 * which writes them onto the TerminalSession so they survive a restart.
 */
export function remoteBridgeOnSessionResumePairing(
  listener: (sessionId: string, pairing: SessionResumePairing) => void,
): void {
  resumePairingListener = listener
}

/** The conversation a session would resume, for the bridge's own commands. */
export function remoteBridgeResumePairing(sessionId: string): SessionResumePairing | null {
  return resumeTracker?.get(sessionId) ?? null
}

/**
 * The transcript each resumed claude session was paired with, by session id
 * (null = looked for one and found none). Memoized because the lookup walks
 * every claude project directory and pushState runs several times a second.
 */
const resumeTranscripts = new Map<string, string | null>()

/**
 * Hand both transcript consumers the JSONL a resumed conversation continues.
 *
 * Neither can find it on its own: the cwd guess derives a project directory from
 * the directory the resume runs in, which is the one the conversation RECORDED
 * (often a subdirectory of where claude first launched, whose slug names a
 * directory that never existed), and the hook report doesn't land until the user
 * types. Until then the chat view sat empty for a session whose terminal
 * mirrored perfectly. The resume command names the conversation, so the file can
 * simply be looked up — see resume-transcript.ts.
 *
 * Fed through noteClaudeTranscript, the same authoritative channel the hook
 * uses, so a later hook report (a resume that forks into a new file) overrides
 * this and the mirror treats it as a conversation swap.
 */
function pairResumedTranscripts(
  sessions: Record<string, { processStatus: string; initialCommand?: string }>,
): void {
  for (const [sessionId, s] of Object.entries(sessions)) {
    // Before the OSC title flips the pane to 'claude' there is nothing tracking
    // it yet — don't memoize a miss for a session that is still booting.
    if (s.processStatus !== 'claude') continue
    if (resumeTranscripts.has(sessionId)) continue
    const resumeId = parseClaudeResumeId(s.initialCommand)
    const file = resumeId ? findClaudeTranscriptById(resumeId) : null
    resumeTranscripts.set(sessionId, file)
    if (!file) continue
    contextTracker?.noteClaudeTranscript(sessionId, file)
    messageMirror?.noteClaudeTranscript(sessionId, file)
  }
  for (const id of [...resumeTranscripts.keys()]) {
    if (!(id in sessions)) resumeTranscripts.delete(id)
  }
}

/**
 * The tracker is created on the first push (which is also the first moment the
 * bridge has a session list) and re-aimed on every push, so it follows sessions
 * being spawned, closed, and swapped between agents.
 */
function trackAgentContext(
  sessions: Record<string, { processStatus: string; cwd: string; initialCommand?: string }>,
): void {
  if (!contextTracker) {
    contextTracker = new AgentContextTracker({
      onChange: () => pushState(),
      resolveCodexTranscript: (sessionId) => resolveCodexTranscriptPath?.(sessionId) ?? null,
    })
  }
  if (!messageMirror) {
    messageMirror = new AgentMessageMirror({
      resolveCodexTranscript: (sessionId) => resolveCodexTranscriptPath?.(sessionId) ?? null,
      // The remote sink is gone with Convex: the phone reads the terminal, and
      // the desktop's chat view reads the local log below. The mirror's buffer
      // drains straight through so nothing accumulates.
      sendAppend: async () => undefined,
      fetchHeadSeq: async () => -1,
      clearSession: async () => undefined,
      // The DESKTOP's own chat view reads this log; it paints the moment the
      // tailer parses.
      onAppend: (sessionId, messages) => agentChatLog.append(sessionId, messages),
      onClear: (sessionId) => { if (!nativeChatActive(sessionId)) agentChatLog.clear(sessionId) },
      // A transcript came into view for this session — tell both clients, so the
      // chat view appears the moment there is one to read.
      onPaired: (sessionId) => {
        if (chatReady.has(sessionId)) return
        chatReady.add(sessionId)
        emitChatReady()
      },
    })
  }
  if (!resumeTracker) {
    resumeTracker = new SessionResumeTracker({
      resolveTranscript: (sessionId) => contextTracker?.getTranscriptFile(sessionId) ?? null,
      onPairing: (sessionId, pairing) => resumePairingListener?.(sessionId, pairing),
    })
  }
  const tracked: TrackedAgentSession[] = []
  // Cursor is tracked for resume only: it writes SQLite rather than a JSONL
  // transcript, so there is nothing for the context tracker or the message
  // mirror to tail.
  const resumeTracked: ResumeTrackedSession[] = []
  for (const [sessionId, s] of Object.entries(sessions)) {
    if (nativeChatActive(sessionId)) continue
    if (s.processStatus === 'claude' || s.processStatus === 'codex') {
      tracked.push({ sessionId, agent: s.processStatus, cwd: s.cwd })
    }
    if (isResumableAgent(s.processStatus)) {
      resumeTracked.push({ sessionId, agent: s.processStatus, cwd: s.cwd })
    }
  }
  // A session that stopped being an agent (closed, or the CLI exited) has no
  // conversation to offer any more — the mirror has just dropped its entry.
  // Notified without a pushState: this runs from inside pushState itself, and
  // the push it is part of already carries the new set.
  let dropped = false
  for (const id of [...chatReady]) {
    if (sessions[id]?.processStatus === 'claude' || sessions[id]?.processStatus === 'codex') continue
    chatReady.delete(id)
    dropped = true
  }
  if (dropped) chatReadyListener?.([...chatReady])
  contextTracker.setSessions(tracked)
  messageMirror.setSessions(tracked.filter(s => !nativeChatActive(s.sessionId)))
  // After setSessions: claude/codex pairings are read off the transcript the
  // context tracker just resolved.
  resumeTracker.update(resumeTracked)
  // After setSessions, so the pairing lands on entries that already exist.
  pairResumedTranscripts(sessions)
}

// Supplied by index.ts, which owns the codex rollout watcher (the authority on
// which rollout file a codex session has open). Left null in tests and before
// the watcher exists — the tracker simply finds no codex transcript until then.
let resolveCodexTranscriptPath: ((sessionId: string) => string | null) | null = null

export function remoteBridgeSetCodexTranscriptResolver(
  resolve: (sessionId: string) => string | null,
): void {
  resolveCodexTranscriptPath = resolve
}

/**
 * A claude hook reported the transcript it is writing for this session — the
 * authoritative pairing, which replaces the tracker's cwd-based guess.
 */
export function remoteBridgeOnClaudeTranscript(sessionId: string, transcriptPath: string): void {
  contextTracker?.noteClaudeTranscript(sessionId, transcriptPath)
  messageMirror?.noteClaudeTranscript(sessionId, transcriptPath)
}

/**
 * A claude session opened an AskUserQuestion form. Mirrored straight from the
 * hook so the chat card is answerable while the form is still open — see
 * AgentMessageMirror.noteClaudeQuestion for why the transcript is too late.
 */
export function remoteBridgeOnClaudeQuestion(
  sessionId: string,
  toolUseId: string,
  toolInput: unknown,
): void {
  messageMirror?.noteClaudeQuestion(sessionId, toolUseId, toolInput)
}

/**
 * Per-session state of the chat-message mirror — buffer depth, last progress,
 * failure count, the head row's uid/seq. The diagnostic for a chat that has
 * frozen while the terminal keeps mirroring.
 */
export function remoteBridgeMessageMirrorSnapshot(): Record<string, unknown>[] {
  return messageMirror?.debugSnapshot() ?? []
}

/**
 * Usage snapshot changed (probe finished, background poll landed). Only pushes
 * when the mirrored numbers actually moved — usage-manager emits on every
 * isSyncing flip, which is twice per probe and every 15s for Codex.
 */
export function remoteBridgeOnUsage(snapshot: UsageSnapshot): void {
  const next = sanitizeUsage(snapshot)
  const key = usageFingerprint(next)
  if (key === lastUsageKey) return
  lastUsage = next
  lastUsageKey = key
  pushState()
}

// Last mirrored update verdict, as a change key only. The payload itself is read
// fresh inside pushState (never cached), so this exists purely to decide whether
// an updater event is worth a push of its own — electron-updater fires on every
// download-progress tick and on every 30-minute background check.
let lastUpdateKey = ''

/**
 * The updater reported something. Push only when the verdict the phone renders
 * actually moved (see updateFingerprint — progress is quantized to 10%).
 */
function onUpdateStatusChanged(): void {
  const key = updateFingerprint(getMirroredUpdate())
  if (key === lastUpdateKey) return
  lastUpdateKey = key
  pushState()
}

export function remoteBridgeOnMirror(data: MirrorPayload): void {
  if (data.workState) rendererWorkState = data.workState
  if (data.attention) rendererAttention = data.attention
  lastMirror = data
  // Transcript tracking runs whether or not the bridge has started: the
  // desktop's own chat view and context meter feed off the same tailers (see
  // agent-chat-log.ts). Cheap and idempotent — setSessions on both trackers
  // diffs against what they hold.
  trackAgentContext(data.sessions)
  pushState(data)
}

/**
 * Per-session context/model numbers for the DESKTOP's own chat composer (its
 * context ring and model pill) — the same tracker the phone's liveStatus reads.
 */
export function getAgentContextSnapshot(): Record<string, AgentContextSnapshot> {
  return contextTracker?.getAll() ?? {}
}

/** Freshest session/workspace topology: the renderer's last mirror, else disk. */
export function getMirrorSnapshot(): MirrorData {
  return lastMirror ?? loadPersistedData()
}

// Geometry push coalescing: the desktop fires resize taps in bursts (fit() runs
// on every layout settle / sidebar animation), so debounce the mirror push.
let geometryPushTimer: ReturnType<typeof setTimeout> | null = null

export function remoteTerminalInputGuard(sessionId: string, token?: unknown): () => void {
  if (!terminalStreamHost && token !== undefined) throw new Error('Terminal connection unavailable')
  return terminalStreamHost?.captureInputGuard(sessionId, token) ?? (() => {})
}

export function remoteBridgeDesktopGeometry(cols: number, rows: number, sessionId?: string): { cols: number; rows: number } {
  const streamGeometry = sessionId ? terminalStreamHost?.geometry(sessionId) : undefined
  if (streamGeometry) return streamGeometry
  return geometryForDesktopRequest(started ? ownership : initialOwnership(), { cols, rows })
}

/**
 * Record the desktop PTY's current geometry for a session and mirror it so any
 * attached phone follows the desktop's width. Called from the desktop's
 * terminal-resize IPC handler.
 */
export function remoteBridgeOnResize(sessionId: string, cols: number, rows: number): void {
  if (!started) return
  // While the web owns geometry the desktop is a scaling viewer and must NOT be
  // driving the PTY. A stray tap here (e.g. a late autofit reconcile racing the
  // owner flip) would clobber webGeometry and fight the phone — drop it.
  if (ownership.owner === 'web' || terminalStreamHost?.geometry(sessionId)) return
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return
  const prev = liveGeometry[sessionId]
  if (prev && prev.cols === cols && prev.rows === rows) return
  liveGeometry[sessionId] = { cols, rows }
  if (geometryPushTimer) clearTimeout(geometryPushTimer)
  geometryPushTimer = setTimeout(() => {
    geometryPushTimer = null
    pushState()
  }, 120)
}

function pushState(fresh?: MirrorPayload): void {
  if (started) statePublisher.push(fresh)
}

async function publishState(fresh?: MirrorPayload): Promise<void> {
  if (!started) return
  // Prefer the fresh state handed in by the realtime mirror, then the last one it
  // sent, and only then disk. The payload-less callers (heartbeat, focus, wake,
  // status taps, context tracker, usage, Linear resolve) are frequent, and falling
  // straight through to disk made every one of them republish a snapshot the
  // renderer had already superseded: the mirrored document ping-ponged between two
  // different session maps several times a second, so the web flashed, its session
  // list reordered continuously, and a session missing from the disk copy lost its
  // worktree and label on every other push. Disk is the boot-time fallback only —
  // its 1s debounce is starved by an agent-boot update storm, so it can lag the
  // store by minutes when several agents are running.
  const data = fresh ?? lastMirror ?? loadPersistedData()
  // Drop liveStatus / liveGeometry / cached work for sessions that no longer exist.
  for (const id of Object.keys(liveStatus)) {
    if (!(id in data.sessions)) delete liveStatus[id]
  }
  for (const id of Object.keys(liveGeometry)) {
    if (!(id in data.sessions)) delete liveGeometry[id]
  }
  for (const id of Object.keys(rendererWorkState)) {
    if (!(id in data.sessions)) delete rendererWorkState[id]
  }
  for (const id of Object.keys(rendererAttention)) {
    if (!(id in data.sessions)) delete rendererAttention[id]
  }
  for (const id of [...chatStoppedAt.keys()]) {
    if (!(id in data.sessions)) chatStoppedAt.delete(id)
  }
  // Merge the authoritative PTY geometry into each session so viewers adopt it.
  // When the web owns geometry every session shares the phone's viewport;
  // otherwise each carries the desktop's per-session live size.
  const sessions = buildSessionMap(data.sessions)
  overlaySessionGeometry(sessions, ownership, liveGeometry)
  for (const [id, session] of Object.entries(sessions)) {
    const geometry = terminalStreamHost?.geometry(id)
    Object.assign(session, {
      terminalStreamVersion: 1,
      geometryOwner: geometry ? 'web' : ownership.owner,
      ...(geometry ?? {}),
    })
  }
  // Re-aim the context tracker at the current agent sessions before reading it,
  // so a session spawned in this very push is already being followed. Fed the
  // unsanitized sessions: the tracker runs main-side and needs initialCommand,
  // which buildSessionMap deliberately keeps out of what the phone receives.
  trackAgentContext(data.sessions)
  // Overlay the renderer's authoritative work state onto the daemon tap so the
  // web shimmers EVERY working agent, not just the few the tap caught mid-
  // transition (see remote-bridge-livestatus.ts).
  const liveStatusOut = buildLiveStatus(
    Object.keys(data.sessions),
    liveStatus,
    rendererWorkState,
    rendererAttention,
    contextTracker?.getAll() ?? {},
    getLastOutputAtBySession(),
    chatReadyByAgent(data.sessions),
    // Scrape each session's screen for a TUI-native prompt (folder trust,
    // permission) that has no transcript/hook, so the phone can card it.
    getTerminalBufferText,
    // Launch commands, for the model/effort a session has before its first turn
    // writes a transcript — otherwise the phone's picker shows blank pills on
    // every freshly spawned agent.
    Object.fromEntries(
      Object.entries(data.sessions).map(([id, s]) => [id, s.initialCommand]),
    ),
  )
  // A chat-owned session runs its agent over the SDK: the PTY underneath is a
  // bare shell, so the process tap and hooks would report it idle and agentless.
  for (const snapshot of nativeChatManager().all()) {
    if (snapshot.view !== 'chat' || !sessions[snapshot.sessionId]) continue
    ;(sessions[snapshot.sessionId] as { processStatus?: string }).processStatus = snapshot.provider
    liveStatusOut[snapshot.sessionId] = {
      ...liveStatusOut[snapshot.sessionId],
      work: ['starting', 'working', 'compacting', 'waiting'].includes(snapshot.status) ? 'working' : 'idle',
      exited: false, model: snapshot.settings.model, effort: snapshot.settings.effort, tuiPrompt: undefined,
    }
  }
  // Kick a fire-and-forget refresh of each worktree's linked Linear ticket; when a
  // cached value changes it re-pushes. sanitizeWorkspaces reads the cache synchronously.
  void resolveLinearIssues(data.workspaces, () => pushState())
  // Same shape for the slash-command catalog the phone's composer autocompletes
  // from: scanned off disk on a slow timer, re-pushed only when it moves. Scoped
  // to each workspace's MAIN tree — a worktree is a checkout of the same repo, so
  // its .claude/commands are the same modulo a branch that just added one.
  refreshSlashCommandCatalog(
    Object.values(data.workspaces)
      .map((w) => ({ workspaceId: w.id, rootDir: w.trees[0]?.rootDir ?? '' }))
      .filter((r) => r.rootDir),
    () => pushState(),
  )
  // The dev servers each session is running: scanned off the process table on a
  // slow clock, re-pushed only when the list moves (same contract as the slash
  // catalog above).
  refreshServerCatalog(async () => {
    const live = await getDaemonClient().listSessions()
    const pids = new Map<number, string>()
    for (const session of live) {
      if (session.isAlive && session.pid) pids.set(session.pid, session.sessionId)
    }
    return pids
  }, () => pushState())
  // The mirror is in-process now: setting it invalidates every phone's
  // subscription synchronously, and the sync hub skips the send when nothing
  // but `updatedAt` moved is not true — updatedAt is the heartbeat the phone's
  // offline banner reads, so every push is delivered.
  remoteState.setRemoteState({
    workspaces: sanitizeWorkspaces(data.workspaces, getCachedLinearIssue, getCachedPullRequest),
    sessions,
    liveStatus: liveStatusOut,
    activeWorkspaceId: data.activeWorkspaceId ?? null,
    activeSessionId: data.activeSessionId ?? null,
    geometryOwner: ownership.owner,
    geometryEpoch: ownership.epoch,
    usage: lastUsage,
    slashCommands: getSlashCommandCatalog() ?? undefined,
    servers: getServerCatalog(),
    // Read straight from the updater on every push — including the
    // payload-less ones — so this field can never carry a stale copy the way
    // the disk fallback once made the session map do.
    updateStatus: getMirroredUpdate(),
  })
}

/**
 * Viewing or typing into a session from the phone acknowledges its pending
 * "needs input" signal, the same way focusing it on the desktop
 * (setActiveSession) or typing into its terminal does. The renderer owns the
 * flag, so forward the ack there; the resulting store change re-mirrors state
 * without the attention entry and the phone's badge drops back to idle.
 */
function acknowledgeRemoteAttention(sessionId: unknown): void {
  if (typeof sessionId === 'string' && sessionId) {
    mainWindow?.webContents.send('remote-acknowledge-attention', sessionId)
  }
}

/** The on-disk path of an image the phone uploaded, or throw if it is gone. */
function uploadedImagePath(context: string, storageId: string): string {
  const path = resolveUpload(storageId)
  if (!path) throw new Error(`${context}: upload ${storageId} is no longer available`)
  return path
}

async function applyOne(cmd: RemoteCommand): Promise<void> {
  const daemon = getDaemonClient()
  switch (cmd.kind) {
    case 'write': {
      // daemon.write() is fire-and-forget: a session whose PTY died with a
      // previous daemon would swallow these keystrokes without a trace. Refuse
      // loudly instead — the mirror already shows the session as exited.
      assertSessionWritable(cmd.sessionId, 'write')
      // A `steps` payload is a paced key sequence (model/effort switches,
      // question answers): the delays must elapse AT THE PTY, not between the
      // phone's calls — network jitter outside claude's slash-command timing
      // window is exactly how the picker silently no-oped. See
      // remote-bridge-key-steps.ts.
      const steps = sanitizeKeySteps(cmd.payload?.steps)
      if (cmd.payload?.steps !== undefined && !steps) throw new Error('Invalid chat control sequence')
      if (steps) {
        // Key steps are agent-TUI protocol. Typed into a session whose CLI has
        // exited (PTY alive, shell at the prompt — codex's self-update quits
        // with "Please restart Codex") they land in zsh: "/model sonnet"
        // scrolls away as a not-found and the phone reads it as the picker
        // dropping the switch. Refuse loudly, like assertSessionWritable.
        // Plain writes stay allowed — the terminal view types into shells on
        // purpose.
        assertSessionRunsAgent(cmd.sessionId)
        await chatInputController.run(cmd.sessionId, (check) => runKeySteps(
          guardedChatInput({
            write: (data) => { assertChatSessionWritable(cmd.sessionId); daemon.write(cmd.sessionId, data) },
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            // Conditional steps (confirmation dialogs) read the live screen —
            // the phone has no view of it.
            readScreen: () => getTerminalBufferText(cmd.sessionId),
          }, check),
          steps,
        ))
      } else {
        daemon.write(cmd.sessionId, String(cmd.payload?.data ?? ''))
      }
      acknowledgeRemoteAttention(cmd.sessionId)
      break
    }
    case 'attach':
      // Terminal output is delivered by the relay now; the phone attaches its
      // viewer there. Viewing a session still acknowledges its attention flag.
      acknowledgeRemoteAttention(cmd.sessionId)
      break
    case 'detach':
    case 'resize':
      // Legacy no-ops. Old web clients emitted a per-session `resize` on the
      // assumption the phone drove the PTY; that fought the desktop's
      // ResizeObserver and garbled the mirror. Geometry is negotiated through
      // the terminal stream lease now.
      break
    case 'claimGeometry':
      // A focused web/phone claims ownership: resize every open PTY to its
      // viewport and flip the desktop into scaling-viewer mode.
      await claimGeometryWeb(Number(cmd.payload?.cols), Number(cmd.payload?.rows))
      break
    case 'kill':
      if (cmd.sessionId) await stopNativeChat(cmd.sessionId)
      await daemon.kill(cmd.sessionId)
      // Killing the PTY leaves the session in the renderer store, so the next
      // state push re-adds the row and the web's swipe-to-trash looks inert.
      // Mirror the desktop "close" (killTerminal + deleteSession) by forwarding
      // the removal to the renderer; the resulting persist re-pushes state
      // without the session and the row disappears.
      mainWindow?.webContents.send('remote-kill-session', cmd.sessionId)
      break
    // Pin / rename: both are renderer-store fields (they ride along in the
    // session map the next push builds), so forward and let the store own them.
    // Neither touches the PTY, so an exited session is still pinnable/renamable —
    // the point of naming one is often that it's done.
    case 'setSessionPinned':
      mainWindow?.webContents.send('remote-set-session-pinned', {
        sessionId: cmd.sessionId,
        pinned: cmd.payload?.pinned !== false,
      })
      break
    case 'renameSession':
      mainWindow?.webContents.send('remote-rename-session', {
        sessionId: cmd.sessionId,
        title: String(cmd.payload?.title ?? '').slice(0, 200),
      })
      break
    case 'runAction':
      // runAction lives in the renderer store; forward to it like webhooks do.
      mainWindow?.webContents.send('remote-run-action', {
        workspaceId: String(cmd.payload?.workspaceId ?? ''),
        actionId: String(cmd.payload?.actionId ?? ''),
      })
      break
    case 'resumeSession': {
      // Reopen a pane on the conversation it was holding. The desktop owns both
      // halves of this — the recorded conversation id and the respawn — so the
      // phone names the session and never the conversation.
      const sessionId = String(cmd.sessionId ?? '')
      if (!sessionId) break
      // A message may ride along: the phone's chat composer sends into a dead
      // pane by resuming it first, so the thing you typed is what the reopened
      // conversation reads. Its images are already on disk (see uploads.ts).
      const { text, images } = normalizeSendChatMessagePayload(cmd.payload)
      if (!text && images.length === 0) {
        mainWindow?.webContents.send('remote-resume-session', { sessionId })
        break
      }
      // Own the entire delivery before the boot starts. Stop can invalidate it
      // even after this command has been acknowledged and left the queue.
      void chatInputController.run(sessionId, async (check) => {
        const paths = images.map((img) => uploadedImagePath('resumeSession', img.storageId))
        check()
        mainWindow?.webContents.send('remote-resume-session', { sessionId })
        const body = [...paths, text].filter(Boolean).join(' ')
        await deliverResumedMessage(sessionId, body, images, check)
      }).catch((error) => console.error('[remote-bridge] resume delivery failed', error))
      break
    }
    case 'createWorktree':
      // Worktree creation lives in the renderer store; forward to it like runAction.
      mainWindow?.webContents.send('remote-create-worktree', normalizeCreateWorktreePayload(cmd.payload))
      break
    case 'spawnInTree':
      // Open a terminal/agent or run an action in a specific tree; renderer-side.
      mainWindow?.webContents.send('remote-spawn-in-tree', normalizeSpawnInTreePayload(cmd.payload))
      break
    case 'removeWorktree': {
      // Delete a worktree (renderer kills its sessions + removes on disk/store).
      const idx = Number(cmd.payload?.treeIndex)
      mainWindow?.webContents.send('remote-remove-worktree', {
        workspaceId: String(cmd.payload?.workspaceId ?? ''),
        treeIndex: Number.isInteger(idx) && idx >= 0 ? idx : 0,
      })
      break
    }
    case 'killServer': {
      // Kill a dev server from the phone. The mirrored row carries the pid and
      // port; killRunningServer takes the subtree down and waits for the port
      // to actually free, then the next scan drops the row.
      const pid = Number(cmd.payload?.pid)
      const port = Number(cmd.payload?.port)
      if (!Number.isInteger(pid) || pid <= 1 || !Number.isInteger(port) || port <= 0) break
      const outcome = await killRunningServer(pid, port)
      if (!outcome.success) console.warn('[remote-bridge] killServer failed', outcome.error)
      // Re-scan on the next push instead of waiting out the 5s clock.
      resetServerCatalog()
      pushState()
      break
    }
    case 'sendImage': {
      // Phone screenshot: the upload already landed on disk; type its path
      // (plus a trailing space, no Enter) into the target session so the user
      // can keep composing from the phone.
      const { storageId } = normalizeSendImagePayload(cmd.payload)
      if (!storageId || !cmd.sessionId) break
      assertSessionWritable(cmd.sessionId, 'sendImage')
      const checkLease = remoteTerminalInputGuard(cmd.sessionId, cmd.payload?.leaseToken)
      const filePath = uploadedImagePath('sendImage', storageId)
      await typeImagePath(chatSendDeps(cmd.sessionId, checkLease), filePath)
      // Delivered — forget the id. The file stays for the agent to read and is
      // swept by pruneRemoteImages once it is old.
      releaseUpload(storageId)
      break
    }
    case 'sendChatMessage': {
      // Chat-composer send with attachments: resolve every uploaded image to
      // its path, then submit "<path> <path> <text>" as ONE bracketed paste.
      // The leading Ctrl-U and trailing delayed CR mirror the web composer's
      // text-only send — the paths must ride inside the same paste, because a
      // Ctrl-U sent after typing them (the sendImage route) would wipe them
      // along with any stray TUI input.
      const { text, images, steer } = normalizeSendChatMessagePayload(cmd.payload)
      if (!cmd.sessionId || (!text && images.length === 0)) break
      const before = cmd.payload?.before === undefined ? null : sanitizeKeySteps(cmd.payload.before)
      if (cmd.payload?.before !== undefined && !before) throw new Error('Invalid chat routing sequence')
      assertChatSessionWritable(cmd.sessionId)
      if (steer) chatInputController.cancel(cmd.sessionId)
      await chatInputController.run(cmd.sessionId, async (check) => {
        const paths = images.map((img) => uploadedImagePath('sendChatMessage', img.storageId))
        check()
        const body = [...paths, text].filter(Boolean).join(' ')
        const deps = guardedChatInput({
          ...chatSendDeps(cmd.sessionId),
          write: (data: string) => { assertChatSessionWritable(cmd.sessionId); daemon.write(cmd.sessionId, data) },
          readScreen: () => getTerminalBufferText(cmd.sessionId),
        }, check)
        if (before) await runKeySteps(deps, before)
        await submitChatMessage(deps, body, { steer })
      })
      acknowledgeRemoteAttention(cmd.sessionId)
      for (const img of images) releaseUpload(img.storageId)
      break
    }
    case 'generateTicketDraft':
      // Fully main-side (decrypt + Linear API + headless agent). Fire-and-forget;
      // the orchestrator writes progress/results to the ticket draft the web
      // subscribes to.
      void generateTicketDraft(String(cmd.payload?.requestId ?? ''), cmd.sessionId)
      break
    case 'createLinearTicket':
      void createLinearTicket(
        String(cmd.payload?.requestId ?? ''),
        cmd.sessionId,
        cmd.payload?.fields ?? {},
      )
      break
    case 'listAgentSessions':
      // Reading a month of transcripts off disk takes long enough to be worth
      // keeping off the command loop, which drains keystrokes for the attached
      // session — so it answers into the agentSessions record asynchronously,
      // the same shape as the ticket-draft flow.
      void serveAgentSessions(String(cmd.payload?.requestId ?? ''))
      break
    case 'restartToUpdate': {
      // "Restart & install the pending update", from the phone. sessionId is
      // unused (app-wide, like runAction's workspace scope).
      //
      // Idempotent in the updater: the first accepted call latches, later ones
      // report 'already-restarting' and do nothing. The quit itself is deferred
      // by a grace window so this command's ack reaches the phone before the
      // process dies.
      const result = requestRestartToUpdate()
      console.log('[remote-bridge] restartToUpdate →', result.action, result.reason ?? '')
      // Mirror the new verdict (restartPending, or the check we just kicked off)
      // so the phone's button reflects the outcome immediately.
      onUpdateStatusChanged()
      break
    }
    case 'resumeAgentSession': {
      // Respawning lives in the renderer (it owns the store, the tree resolution
      // and the terminal), so forward it there like runAction/spawnInTree.
      const resume = normalizeResumeSessionPayload(cmd.payload)
      if (resume) mainWindow?.webContents.send('remote-resume-agent-session', resume)
      break
    }
    default:
      throw new Error(`Unknown command: ${cmd.kind}`)
  }
}

/** Fill the agentSessions record the web is watching (or mark it failed). */
async function serveAgentSessions(requestId: string): Promise<void> {
  if (!requestId) return
  try {
    const sessions = toRemoteAgentSessions(await listRecentAgentSessions())
    remoteState.fulfillAgentSessions(requestId, sessions)
  } catch (err) {
    console.error('[remote-bridge] listAgentSessions failed', err)
    remoteState.failAgentSessions(requestId, String(err))
  }
}

/**
 * Second half of a chat-composer send into a dead pane: the respawn has been
 * asked for, now wait it out and type the message into what comes up. Runs
 * detached from the command queue — see the call site.
 */
async function deliverResumedMessage(
  sessionId: string,
  body: string,
  images: { storageId: string }[],
  check: () => void,
): Promise<void> {
  // Anything the respawned process printed lands in this session's buffer; a
  // last-output stamp newer than the moment we asked for the resume is the only
  // "it came back" signal that needs no daemon round trip.
  const askedAt = Date.now()
  try {
    const deps = guardedChatInput({
      ...chatSendDeps(sessionId),
      write: (data: string) => { assertChatSessionWritable(sessionId); getDaemonClient().write(sessionId, data) },
      readScreen: () => getTerminalBufferText(sessionId),
    }, check)
    const result = await deliverAfterResume({
      ...deps,
      sawOutput: () => hasRecentTerminalOutput(sessionId, Date.now() - askedAt),
      readPrompt: () => detectTuiPrompt(getTerminalBufferText(sessionId)),
      // Authoritative "the respawn happened", asked once before we type.
      isAlive: async () => {
        try {
          const live = await getDaemonClient().listSessions()
          return live.some((s) => s.sessionId === sessionId && s.isAlive)
        } catch {
          // An unavailable connection cannot acknowledge a resumed send.
          return false
        }
      },
      runKeys: (keys) => runKeySteps(deps, keys),
    }, body)
    if (!result.delivered) {
      console.warn('[remote-bridge] resumeSession: no process came up for', sessionId, '— message not sent')
      return
    }
    console.log('[remote-bridge] resumeSession delivered', sessionId, `(${result.autoAnswered} prompt(s) auto-answered)`)
    acknowledgeRemoteAttention(sessionId)
    for (const img of images) releaseUpload(img.storageId)
  } catch (err) {
    console.error('[remote-bridge] resumeSession delivery failed', sessionId, err)
  }
}

/** Refuse input for a session whose PTY is confirmed gone (see pty-liveness.ts).
 *  Throwing surfaces as the command's error on the phone instead of the write
 *  disappearing into a daemon that has never heard of the session. */
function assertSessionWritable(sessionId: unknown, kind: string): void {
  if (typeof sessionId === 'string' && ptyLiveness.isDead(sessionId)) {
    throw new Error(
      `${kind} dropped: session ${sessionId} has no live PTY (its daemon is gone — reopen or resume the session)`,
    )
  }
}

/** Steps-only companion to assertSessionWritable: the PTY may be perfectly
 *  alive while the agent CLI inside it has exited, and key steps only mean
 *  anything to an agent TUI. */
function assertSessionRunsAgent(sessionId: unknown): void {
  if (typeof sessionId !== 'string') return
  const status = getMirrorSnapshot().sessions[sessionId]?.processStatus
  if (status !== 'claude' && status !== 'codex') {
    throw new Error(
      `steps dropped: session ${sessionId} has no agent CLI running (status: ${status ?? 'unknown'}) — resume the agent first`,
    )
  }
}

/** All chat controls fail explicitly if their transport or agent has gone. */
export function assertChatSessionWritable(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId === 'string' && nativeChatActive(sessionId)) throw new Error('This conversation uses native chat controls')
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid chat session')
  if (!getDaemonClient().isConnected()) throw new Error('Agent connection is unavailable')
  assertSessionWritable(sessionId, 'chat')
  assertSessionRunsAgent(sessionId)
}

export function nativeChatStateChanged(_sessionId?: string): void {
  invalidateNativeChat()
  trackAgentContext(getMirrorSnapshot().sessions)
  chatReadyListener?.(getChatReadySessions())
  pushState()
}
