import { TerminalStreamHost } from './terminal-stream-host'
import { geometryForDesktopRequest } from './remote-bridge-geometry'
import { nativeChatSnapshot, stopNativeChat } from './native-chat/service'
import { scheduleNativeChatPublish, stopNativeChatRemote } from './native-chat/remote'
// Always-on bridge: mirrors sanitized workspace/session state to Convex and
// relays PTY I/O for the single session the web has attached. Inert if the
// DEVICE_SECRET env var is unset.

import { powerMonitor, powerSaveBlocker, type BrowserWindow } from 'electron'
import { ConvexClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { CONVEX_CLOUD_URL, DEVICE_SECRET } from './convex-config'
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
  saveRemoteImage,
  pruneRemoteImages,
} from './remote-bridge-image'
import {
  normalizeResumeSessionPayload,
  toRemoteAgentSessions,
} from './remote-bridge-agent-sessions'
import { listRecentAgentSessions } from './agent-session-history'
import { createOutputBatcher, type OutputBatcher } from './remote-bridge-batcher'
import { createResubscriber, type Resubscriber } from './remote-bridge-resubscribe'
import { runKeySteps, sanitizeKeySteps } from './remote-bridge-key-steps'
import { chatInputController, guardedChatInput } from './chat-input-controller'
import { RemoteChatInterrupts } from './remote-chat-interrupts'
import { createApplyQueue } from './remote-bridge-apply-queue'
import { createCommandDrain } from './remote-bridge-command-drain'
import { reflowResize } from './remote-bridge-resize-nudge'
import {
  initialOwnership,
  claimWeb,
  reclaimDesktop,
  overlaySessionGeometry,
  planDesktopRestore,
  type Geometry,
  type GeometryOwnership,
} from './remote-bridge-geometry'
import { ChunkSeq } from './remote-bridge-seq'
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

const FLUSH_MS = 16
const MAX_BYTES = 16 * 1024


// Pushes are otherwise change-triggered and fire-and-forget: if the last push
// after a close/exit is dropped (app slept/quit before the persist debounce
// flushed, a transient Convex error, or the bridge briefly down), Convex — and
// every mobile client — keeps the stale session list until some unrelated
// change happens to push again. A periodic reconciliation push guarantees the
// latest state always lands within one interval, and we also reconcile
// immediately when the desktop regains focus or wakes from sleep.
const HEARTBEAT_MS = 10_000

// The command loop hangs off a single onUpdate(pendingCommands) subscription. A
// websocket that wedges "connected but silent" — which the Convex client's own
// reconnect won't catch — leaves the desktop unable to drain commands: attaching
// stops seeding the phone (black terminal) and spawning does nothing, while the
// state-push heartbeat keeps the sidebar looking fine. Re-create the subscription
// on a fixed interval (and on wake) so a wedged one is always replaced within an
// interval; re-subscribing immediately refires the current pending list.
const RESUBSCRIBE_MS = 30_000

// The push direction needs the same wedged-socket guard the command loop above
// has. Pushes are queued by the Convex client while its websocket is down, so a
// drop is invisible: the heartbeat keeps enqueuing, nothing throws, and the web
// mirror silently freezes until the socket happens to come back (observed: ~18
// minutes stale, then a rewinding replay of the whole backlog). The heartbeat
// guarantees a push attempt every HEARTBEAT_MS, so "no push has resolved in a
// while" is a reliable liveness signal — when it trips, rebuild the client.
const PUSH_WATCHDOG_MS = 15_000
const PUSH_STALL_MS = 45_000

// DECSET mouse-tracking enables. The snapshot's rehydrate sequences replay
// whatever modes were armed at capture time; if an agent TUI had mouse tracking
// on, a freshly attached web/phone client would inherit it and spray mouse
// reports ("35;31;18M") on every scroll. A live agent re-enables mouse tracking
// through the normal PTY stream, so dropping it from the seed is safe.
const MOUSE_ENABLE_RE = /\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1015)h/g

let client: ConvexClient | null = null
let commandSub: Resubscriber | null = null
const chatInterrupts = new RemoteChatInterrupts((sessionId) => {
  chatInputController.cancel(sessionId)
  assertChatSessionWritable(sessionId)
  getDaemonClient().write(sessionId, '\x1b')
  acknowledgeRemoteAttention(sessionId)
}, (error) => console.error('[remote-bridge] interrupt failed', error))
// Serialized command application: the drain guarantees at-most-once apply per
// command id even when a stale snapshot replays (see remote-bridge-command-drain
// — the v1.21.30 spawn storm), the queue guarantees snapshots never interleave
// and never wedge on a failure (see remote-bridge-apply-queue).
const commandDrain = createCommandDrain(
  (cmd) => chatInterrupts.shouldApply(cmd) ? applyOne(cmd) : Promise.resolve(),
  async (id) => {
    await getClient().mutation(anyApi.remote.deleteCommand, { secret: DEVICE_SECRET, id })
    chatInterrupts.acknowledged(id)
  },
  (context, err) => console.error(`[remote-bridge] ${context}`, err),
)
const applyQueue = createApplyQueue(
  (batch) => commandDrain.drain(batch),
  (err) => console.error('[remote-bridge] command batch failed', err),
)
let resubscribeTimer: ReturnType<typeof setInterval> | null = null
// macOS App Nap. With the window behind something else and no user events
// arriving, the OS throttles this process's timers and sockets — the heartbeat,
// the 30s resubscribe, and delivery on the command socket all stall together,
// and the phone's spawns pile up until the mouse crosses the window (that event
// is what ends the nap; 2026-08-16: "all the sessions I tried to open opened at
// once the moment I moved the mouse over the desktop"). The bridge exists to
// serve a phone that is by definition used while the desktop is idle, so keep
// the process awake for as long as the bridge runs.
let appSuspensionBlocker: number | null = null
// Subscriptions opened by other modules against this same client (dictation's
// pendingDictation loop). They die with the client on recreateClient() and wedge
// the same silent way the command loop does, so they refresh on the same beats.
// A registry rather than a direct call keeps the dependency pointing one way:
// those modules import the bridge, never the reverse.
const clientSubs = new Set<() => void>()
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

// Settle applied to a background PTY between resize and the next one, and the
// re-seed nudge, so each SIGWINCH actually reaches the TUI before the snapshot.
const RESEED_SETTLE_MS = 80

function isSaneDim(cols: number, rows: number): boolean {
  return Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0
}

// Writes into an agent TUI are paced against the terminal falling silent rather
// than by a fixed delay — see remote-bridge-chat-send.ts for why (a blind delay
// races the TUI reading a pasted image off disk, and the message is silently
// swallowed or glued onto whatever was already in the composer).
function chatSendDeps(sessionId: string): ChatSendDeps {
  const daemon = getDaemonClient()
  return {
    write: (data) => daemon.write(sessionId, data),
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
 * phone's viewport, flip ownership so the desktop stops auto-fitting (and starts
 * scaling to view), and re-seed the attached session at the new size so the
 * phone's 1:1 xterm receives a snapshot that matches it (seed-geometry invariant).
 */
async function claimGeometryWeb(cols: number, rows: number): Promise<void> {
  if (!isEnabled()) return
  const { state, changed } = claimWeb(ownership, cols, rows)
  if (!changed) return
  if (ownership.owner === 'desktop') preClaimGeometry = { ...liveGeometry }
  ownership = state
  await resizeAllSessions(cols, rows)
  // Tell the desktop renderer to stop driving the PTY and scale to view instead.
  mainWindow?.webContents.send('remote-geometry-owner', {
    owner: 'web', cols, rows, epoch: ownership.epoch,
  })
  // Re-seed the currently-viewed session at the new geometry (attach() reflows
  // the PTY to webGeometry before snapshotting when the web owns).
  if (attachedSessionId) await attach(attachedSessionId)
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
  if (!isEnabled()) return
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

// Attached-session streaming state.
let terminalStreamHost: TerminalStreamHost | null = null
let attachedSessionId: string | null = null
// Monotonic, per-session chunk sequence that NEVER resets to 0 (see ChunkSeq).
// The web's afterSeq cursor only climbs and getChunks filters seq>afterSeq, so a
// reset would strand every already-watching client on an empty result forever —
// the "stuck terminal, must reopen the PWA" freeze.
const chunkSeq = new ChunkSeq()
let batcher: OutputBatcher | null = null
// PTY bytes emitted after the seed snapshot was taken but before the batcher
// exists to carry them, tagged with the attach that armed the hold. See attach()
// for why dropping them corrupts the mirror permanently.
let pendingOutput: { gen: number; parts: string[] } | null = null
// Bumped by every attach so a slow one that has been superseded — the web's
// attach watchdog re-fires every 2.5s, a geometry re-seed can land mid-flight —
// bails out instead of clobbering the newer attach's batcher and seq ordering.
let attachGen = 0

// Reconciliation: periodic heartbeat + wake/focus listeners (registered in
// startRemoteBridge, torn down in stopRemoteBridge).
let heartbeat: ReturnType<typeof setInterval> | null = null
const reconcile = (): void => { pushState() }

// Push-liveness watchdog (see PUSH_WATCHDOG_MS).
let pushWatchdog: ReturnType<typeof setInterval> | null = null
// When the last state push settled. Seeded on start so the first window is full.
let lastPushOkAt = 0

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
      if (id === attachedSessionId) detach()
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

/**
 * Tear down the Convex client and build a fresh one. Every subscription belongs
 * to the old client, so all of them have to be dropped and reopened against the
 * new one — subscribeCommands() rebuilds the Resubscriber around getClient() and
 * refreshes the registered subscriptions (registerRemoteSubscription) too. Miss
 * one and it stays deaf for the rest of the run while the bridge looks healthy.
 */
function recreateClient(): void {
  const dead = client
  client = null
  commandSub?.stop()
  commandSub = null
  void dead?.close().catch((err: unknown) => {
    console.error('[remote-bridge] closing wedged client failed', err)
  })
  // Full grace window before the watchdog may fire again, so a backend outage
  // can't turn into a client-rebuild loop.
  lastPushOkAt = Date.now()
  subscribeCommands()
  pushState()
}

const checkPushLiveness = (): void => {
  if (!isEnabled()) return
  const stalledFor = Date.now() - lastPushOkAt
  if (stalledFor < PUSH_STALL_MS) return
  const state = client?.connectionState()
  console.error(
    `[remote-bridge] no state push has settled in ${Math.round(stalledFor / 1000)}s ` +
      `(socket=${state?.isWebSocketConnected} retries=${state?.connectionRetries} ` +
      `inflightMutations=${state?.inflightMutations}) — rebuilding client`,
  )
  recreateClient()
}

/**
 * Register a subscription that rides this module's Convex client so the bridge
 * re-opens it whenever it re-opens its own: on the resubscribe timer, on focus,
 * on wake, and — the load-bearing case — after recreateClient(), which closes
 * the client out from under every subscription on it. Returns an unregister fn.
 *
 * Without this, a caller's subscription is orphaned by the first client rebuild
 * and never delivers again, while the bridge's own loops look perfectly healthy.
 */
export function registerRemoteSubscription(refresh: () => void): () => void {
  clientSubs.add(refresh)
  return () => clientSubs.delete(refresh)
}

// Open (or re-open) the command subscription, and every subscription registered
// against our client. Wrapped in a Resubscriber so the previous handle is always
// disposed first — a leaked one would deliver, and apply, every pending command
// twice.
function subscribeCommands(): void {
  if (!commandSub) {
    commandSub = createResubscriber(() =>
      getClient().onUpdate(
        anyApi.remote.pendingCommands,
        { secret: DEVICE_SECRET },
        // Serialized: applyOne can take real time (paced key sequences), and a
        // subscription update arriving mid-sequence must not start draining the
        // next command into the PTY on top of it.
        (commands: any[]) => {
          const pending = commands ?? []
          chatInterrupts.observe(pending)
          applyQueue.enqueue(pending)
        },
        (err: Error) => { console.error('[remote-bridge] command subscription error', err) },
      ),
    )
  }
  commandSub.resubscribe()
  // One bad registrant must not stop the rest (or the command loop) refreshing.
  for (const refresh of clientSubs) {
    try {
      refresh()
    } catch (err) {
      console.error('[remote-bridge] registered subscription refresh failed', err)
    }
  }
}

// Focus path: push the latest state AND refresh the command subscription, since a
// "connected but silent" socket is most likely when returning to the window.
// Deliberately does NOT re-seed the terminal — that would thrash an attached
// phone viewer on every desktop focus (re-seed belongs on real wake, below).
const onFocus = (): void => {
  reconcile()
  subscribeCommands()
}

// Wake path (resume / unlock): everything onFocus does, plus rebuild the terminal
// body. While the Mac slept the bridge's push pipeline (batcher timer, websocket)
// was frozen, and pushState() only refreshes the sidebar/session state — it never
// re-seeds chunks, so the terminal would stay frozen on its last pre-sleep frame
// even after the sidebar caught up. Re-attaching re-seeds the attached session
// (clear + fresh snapshot + a seed chunk) at the next monotonic seq, so a frozen
// web viewer repaints.
const onWake = (): void => {
  onFocus()
  if (attachedSessionId) void attach(attachedSessionId)
}

// Flush whatever the batcher holds before the machine suspends/locks, so the
// last frame lands in Convex instead of dying with the timer mid-throttle.
const onSuspend = (): void => { batcher?.flush() }


function isEnabled(): boolean {
  return !!DEVICE_SECRET && !!CONVEX_CLOUD_URL
}

function getClient(): ConvexClient {
  if (!client) client = new ConvexClient(CONVEX_CLOUD_URL)
  return client
}

export function isRemoteBridgeEnabled(): boolean {
  return isEnabled()
}

export function getRemoteClient(): ConvexClient {
  return getClient()
}

/** Force an immediate state mirror push (e.g. after a branch rename changes a
 *  worktree's linked Linear ticket, so the web's icon updates without waiting
 *  for the next heartbeat). No-op when the bridge is disabled. */
export function remoteBridgeForcePush(): void {
  pushState()
}

export function startRemoteBridge(window: BrowserWindow): void {
  mainWindow = window
  if (!isEnabled()) {
    console.log('[remote-bridge] disabled (no DEVICE_SECRET) — running local-only')
    return
  }

  terminalStreamHost?.dispose()
  terminalStreamHost = new TerminalStreamHost({
    daemon: getDaemonClient(), secret: DEVICE_SECRET,
    endpoint: process.env.ORCHESTRA_TERMINAL_RELAY_URL,
    onGeometry(sessionId, geometry, epoch) {
      if (geometry) liveGeometry[sessionId] = geometry
      mainWindow?.webContents.send('remote-geometry-owner', {
        sessionId, owner: geometry ? 'web' : 'desktop', ...geometry, epoch,
      })
      pushState()
    },
  })

  // Output tap → batched chunk append (legacy sessions only).
  getDaemonClient().setTerminalDataTap((sessionId, data) => {
    if (sessionId !== attachedSessionId) return
    // Mid-attach, past the snapshot: these bytes are in neither the seed nor any
    // future frame. Hold them rather than drop them (see attach()).
    if (pendingOutput) {
      pendingOutput.parts.push(data)
      return
    }
    batcher?.push(data)
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
    if (sessionId === attachedSessionId) detach()
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

  // Command loop. Periodically re-create the subscription so a wedged socket
  // (connected but no longer delivering) can't permanently stall the loop.
  subscribeCommands()
  resubscribeTimer = setInterval(subscribeCommands, RESUBSCRIBE_MS)

  // Reconcile the mirror whenever a change-triggered push might have been
  // missed: on a fixed heartbeat, when the window regains focus, and when the
  // machine wakes from sleep / unlocks. The wake events also refresh the command
  // subscription (onWake), since that's when a socket is most likely stale.
  heartbeat = setInterval(reconcile, HEARTBEAT_MS)
  // Watch that those heartbeat pushes actually settle; rebuild the client if not.
  lastPushOkAt = Date.now()
  pushWatchdog = setInterval(checkPushLiveness, PUSH_WATCHDOG_MS)
  // Keep the mirror honest about which sessions still have a PTY behind them.
  ptyLivenessTimer = setInterval(() => void pollPtyLiveness(), PTY_LIVENESS_POLL_MS)
  window.on('focus', onFocus)
  powerMonitor.on('resume', onWake)
  powerMonitor.on('unlock-screen', onWake)
  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('lock-screen', onSuspend)

  // Initial state push.
  pushState()
  // Sweep remote-image files left by previous runs (best-effort, off the
  // critical path).
  void pruneRemoteImages()
  console.log('[remote-bridge] started')
}

export function stopRemoteBridge(): void {
  terminalStreamHost?.dispose()
  terminalStreamHost = null
  stopNativeChatRemote()
  setUpdateStatusListener(null)
  if (appSuspensionBlocker !== null) {
    if (powerSaveBlocker.isStarted(appSuspensionBlocker)) powerSaveBlocker.stop(appSuspensionBlocker)
    appSuspensionBlocker = null
  }
  commandSub?.stop()
  commandSub = null
  if (resubscribeTimer) {
    clearInterval(resubscribeTimer)
    resubscribeTimer = null
  }
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
  if (pushWatchdog) {
    clearInterval(pushWatchdog)
    pushWatchdog = null
  }
  if (ptyLivenessTimer) {
    clearInterval(ptyLivenessTimer)
    ptyLivenessTimer = null
  }
  mainWindow?.off('focus', onFocus)
  powerMonitor.off('resume', onWake)
  powerMonitor.off('unlock-screen', onWake)
  powerMonitor.off('suspend', onSuspend)
  powerMonitor.off('lock-screen', onSuspend)
  batcher?.dispose()
  batcher = null
  attachedSessionId = null
}

export function remoteBridgeOnStatePersisted(_data: PersistedData): void {
  if (!isEnabled()) return
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

/**
 * Realtime state mirror. Pushes the latest sanitized desktop state to Convex the
 * instant the renderer's store changes, decoupled from the 1s disk-persist
 * debounce. This is what makes a session spawned/closed on the desktop appear on
 * a phone within ~one frame instead of seconds later (the debounce was reset by
 * every store update, so a booting agent's update storm starved the old push).
 */
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

// Structured chat mirror: tails the same agent sessions' transcripts and
// pushes parsed ChatMessages for the phone's chat view. Shares the tracker's
// lifecycle (created on first push, re-aimed on every push) and its transcript
// resolution, but writes to its own Convex table via the injected calls below.
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
 * types. Until then the phone's chat view sat empty for a session whose terminal
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
 * bridge is enabled and has a session list) and re-aimed on every push, so it
 * follows sessions being spawned, closed, and swapped between agents.
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
      sendAppend: (sessionId, messages) =>
        getClient().mutation(anyApi.remote.appendMessages, {
          secret: DEVICE_SECRET, sessionId, messages,
        }),
      fetchHeadSeq: async (sessionId) => {
        const head = await getClient().query(anyApi.remote.messagesHeadSeq, {
          secret: DEVICE_SECRET, sessionId,
        })
        return typeof head === 'number' ? head : -1
      },
      // Guarded, unlike the two above: clears fire from the tailer directly
      // (untrack, conversation swap) rather than out of flush(), so with the
      // bridge unconfigured this would build a Convex client to talk to nothing.
      clearSession: (sessionId) =>
        isEnabled() && !nativeChatSnapshot(sessionId)
          ? getClient().mutation(anyApi.remote.clearMessages, { secret: DEVICE_SECRET, sessionId })
          : Promise.resolve(),
      // The DESKTOP's own chat view reads this log — no Convex in the loop, so
      // it renders with the bridge off and paints the moment the tailer parses.
      onAppend: (sessionId, messages) => agentChatLog.append(sessionId, messages),
      onClear: (sessionId) => { if (!nativeChatSnapshot(sessionId)) agentChatLog.clear(sessionId) },
      // A transcript came into view for this session — tell both clients, so the
      // chat view appears the moment there is one to read.
      onPaired: (sessionId) => {
        if (chatReady.has(sessionId)) return
        chatReady.add(sessionId)
        emitChatReady()
      },
      sinkReady: isEnabled,
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
    if (nativeChatSnapshot(sessionId)) continue
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
  messageMirror.setSessions(tracked.filter(s => !nativeChatSnapshot(s.sessionId)))
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
 * hook so the phone's card is answerable while the form is still open — see
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
 * frozen while the terminal keeps mirroring: it localizes the stall (which
 * session, wedged flush vs poison batch vs orphaned promise) WITHOUT the app
 * restart that used to be the only recovery and destroyed the evidence.
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
  if (!isEnabled()) return
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
  if (!isEnabled()) return
  const key = updateFingerprint(getMirroredUpdate())
  if (key === lastUpdateKey) return
  lastUpdateKey = key
  pushState()
}

export function remoteBridgeOnMirror(data: MirrorPayload): void {
  if (data.workState) rendererWorkState = data.workState
  if (data.attention) rendererAttention = data.attention
  lastMirror = data
  // Transcript tracking runs whether or not the cloud bridge is configured: the
  // desktop's own chat view and context meter feed off the same tailers (see
  // agent-chat-log.ts), and pushState below is gated on the bridge. Cheap and
  // idempotent — setSessions on both trackers diffs against what they hold.
  trackAgentContext(data.sessions)
  if (!isEnabled()) return
  pushState(data)
}

/**
 * Per-session context/model numbers for the DESKTOP's own chat composer (its
 * context ring and model pill) — the same tracker the phone's liveStatus reads,
 * queried directly instead of round-tripping through Convex.
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

/**
 * Record the desktop PTY's current geometry for a session and mirror it so any
 * attached phone follows the desktop's width. Called from the desktop's
 * terminal-resize IPC handler.
 */
export function remoteBridgeDesktopGeometry(cols: number, rows: number, sessionId?: string): { cols: number; rows: number } {
  const streamGeometry = sessionId ? terminalStreamHost?.geometry(sessionId) : undefined
  if (streamGeometry) return streamGeometry
  return geometryForDesktopRequest(isEnabled() ? ownership : initialOwnership(), { cols, rows })
}

export function remoteBridgeOnResize(sessionId: string, cols: number, rows: number): void {
  if (!isEnabled()) return
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
  if (!isEnabled()) return
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
  getClient()
    .mutation(anyApi.remote.pushRemoteState, {
      secret: DEVICE_SECRET,
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
      // Stamped HERE, not server-side: a queued push that lands minutes late must
      // still be ordered by when its payload was built (see pushRemoteState).
      pushSeq: Date.now(),
    })
    .then((res: any) => {
      // Liveness signal for the watchdog. A rejected-as-stale push still proves
      // the socket works, so it counts too.
      lastPushOkAt = Date.now()
      if (res && res.accepted === false) {
        console.warn('[remote-bridge] state push superseded (stale replay dropped)')
      }
    })
    .catch((err: unknown) => {
      // Previously fire-and-forget: a dead socket silently swallowed every push
      // while the heartbeat kept "succeeding", so the mirror could sit minutes
      // behind with nothing in the logs.
      console.error('[remote-bridge] state push failed', err)
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

async function applyOne(cmd: any): Promise<void> {
  const daemon = getDaemonClient()
  switch (cmd.kind) {
    case 'attach':
      await attach(cmd.sessionId, Number(cmd.payload?.cols), Number(cmd.payload?.rows))
      acknowledgeRemoteAttention(cmd.sessionId)
      break
    case 'detach':
      detach()
      break
    case 'write': {
      // daemon.write() is fire-and-forget: a session whose PTY died with a
      // previous daemon would swallow these keystrokes without a trace. Refuse
      // loudly instead — the mirror already shows the session as exited.
      assertSessionWritable(cmd.sessionId, 'write')
      // A `steps` payload is a paced key sequence (model/effort switches,
      // question answers): the delays must elapse AT THE PTY, not between the
      // phone's mutations — network jitter outside claude's slash-command
      // timing window is exactly how the picker silently no-oped. See
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
    case 'resize':
      // Legacy no-op. Old web clients emitted a per-session `resize` on the
      // assumption the phone drove the PTY; that fought the desktop's
      // ResizeObserver and garbled the mirror. Geometry is now negotiated
      // through the ownership model (`claimGeometry`), so a bare `resize` from a
      // stale web build is still ignored.
      break
    case 'claimGeometry':
      // A focused web/phone claims ownership: resize every open PTY to its
      // viewport, flip the desktop into scaling-viewer mode, and re-seed.
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
      // pane by resuming it first (ChatPane.sendDraft), so the thing you typed
      // is what the reopened conversation reads. Land its images on disk BEFORE
      // the respawn — the download is the slow part and the boot can absorb it.
      const { text, images } = normalizeSendChatMessagePayload(cmd.payload)
      if (!text && images.length === 0) {
        mainWindow?.webContents.send('remote-resume-session', { sessionId })
        break
      }
      // Own the entire delivery before downloads/boot start. Stop can invalidate
      // it even after this command has been acknowledged and left the queue.
      void chatInputController.run(sessionId, async (check) => {
        const c = getClient()
        const paths: string[] = []
        for (const img of images) {
          const url = await c.query(anyApi.remote.imageUrl, {
            secret: DEVICE_SECRET,
            storageId: img.storageId,
          })
          check()
          if (!url) throw new Error(`resumeSession: no URL for storageId ${img.storageId}`)
          const res = await fetch(url)
          check()
          if (!res.ok) throw new Error(`resumeSession: download failed (${res.status})`)
          paths.push(await saveRemoteImage(new Uint8Array(await res.arrayBuffer()), img.mime))
          check()
        }
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
      // Phone screenshot: download the blob the web uploaded to Convex storage,
      // land it on disk, and type its path (plus a trailing space, no Enter)
      // into the target session so the user can keep composing from the phone.
      const { storageId, mime } = normalizeSendImagePayload(cmd.payload)
      if (!storageId || !cmd.sessionId) break
      assertSessionWritable(cmd.sessionId, 'sendImage')
      const c = getClient()
      const url = await c.query(anyApi.remote.imageUrl, { secret: DEVICE_SECRET, storageId })
      if (!url) throw new Error(`sendImage: no URL for storageId ${storageId}`)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`sendImage: download failed (${res.status})`)
      const filePath = await saveRemoteImage(new Uint8Array(await res.arrayBuffer()), mime)
      await typeImagePath(chatSendDeps(cmd.sessionId), filePath)
      // Blob delivered — drop it. A miss here is mopped up by pruneRemote.
      await c.mutation(anyApi.remote.deleteImage, { secret: DEVICE_SECRET, storageId })
      break
    }
    case 'sendChatMessage': {
      // Chat-composer send with attachments: land every uploaded image on disk
      // first, then submit "<path> <path> <text>" as ONE bracketed paste. The
      // leading Ctrl-U and trailing delayed CR mirror the web composer's
      // text-only send (ChatPane.sendDraft) — the paths must ride inside the
      // same paste, because a Ctrl-U sent after typing them (the sendImage
      // route) would wipe them along with any stray TUI input.
      const { text, images, steer } = normalizeSendChatMessagePayload(cmd.payload)
      if (!cmd.sessionId || (!text && images.length === 0)) break
      const before = cmd.payload?.before === undefined ? null : sanitizeKeySteps(cmd.payload.before)
      if (cmd.payload?.before !== undefined && !before) throw new Error('Invalid chat routing sequence')
      assertChatSessionWritable(cmd.sessionId)
      if (steer) chatInputController.cancel(cmd.sessionId)
      const c = getClient()
      await chatInputController.run(cmd.sessionId, async (check) => {
        const paths: string[] = []
        for (const img of images) {
          const url = await c.query(anyApi.remote.imageUrl, {
            secret: DEVICE_SECRET,
            storageId: img.storageId,
          })
          check()
          if (!url) throw new Error(`sendChatMessage: no URL for storageId ${img.storageId}`)
          const res = await fetch(url)
          check()
          if (!res.ok) throw new Error(`sendChatMessage: download failed (${res.status})`)
          paths.push(await saveRemoteImage(new Uint8Array(await res.arrayBuffer()), img.mime))
          check()
        }
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
      for (const img of images) {
        await c.mutation(anyApi.remote.deleteImage, {
          secret: DEVICE_SECRET,
          storageId: img.storageId,
        })
      }
      break
    }
    case 'generateTicketDraft':
      // Fully main-side (decrypt + Linear API + headless agent + Convex secret
      // write). Fire-and-forget; the orchestrator writes progress/results to the
      // ticketDrafts table that the web polls.
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
      // session — so it answers into the agentSessions row asynchronously, the
      // same shape as the ticket-draft flow.
      void serveAgentSessions(String(cmd.payload?.requestId ?? ''))
      break
    case 'restartToUpdate': {
      // "Restart & install the pending update", from the phone. sessionId is
      // unused (app-wide, like runAction's workspace scope).
      //
      // Idempotent in the updater: the first accepted call latches, later ones
      // report 'already-restarting' and do nothing — which matters here beyond
      // the drain's per-id guard, because two taps are two distinct rows. The
      // quit itself is deferred by a grace window so this command's ack (issued
      // by the drain right after this returns) reaches Convex before the process
      // dies; otherwise the row would still be pending after the restart.
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
  }
}

/** Fill the agentSessions row the web is watching (or mark it failed). */
async function serveAgentSessions(requestId: string): Promise<void> {
  if (!requestId) return
  const c = getClient()
  try {
    const sessions = toRemoteAgentSessions(await listRecentAgentSessions())
    await c.mutation(anyApi.agentSessions.fulfillAgentSessions, {
      secret: DEVICE_SECRET, requestId, sessions,
    })
  } catch (err) {
    console.error('[remote-bridge] listAgentSessions failed', err)
    await c
      .mutation(anyApi.agentSessions.failAgentSessions, {
        secret: DEVICE_SECRET, requestId, error: String(err),
      })
      .catch((mutationErr: unknown) => {
        console.error('[remote-bridge] failAgentSessions failed', mutationErr)
      })
  }
}

/**
 * Second half of a chat-composer send into a dead pane: the respawn has been
 * asked for, now wait it out and type the message into what comes up. Runs
 * detached from the command drain — see the call site.
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
    const c = getClient()
    for (const img of images) {
      await c.mutation(anyApi.remote.deleteImage, { secret: DEVICE_SECRET, storageId: img.storageId })
    }
  } catch (err) {
    console.error('[remote-bridge] resumeSession delivery failed', sessionId, err)
  }
}

/** Refuse input for a session whose PTY is confirmed gone (see pty-liveness.ts).
 *  Throwing surfaces in the command drain's error log instead of the write
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
  if (typeof sessionId === 'string' && nativeChatSnapshot(sessionId)) throw new Error('This conversation uses native chat controls')
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid chat session')
  if (!getDaemonClient().isConnected()) throw new Error('Agent connection is unavailable')
  assertSessionWritable(sessionId, 'chat')
  assertSessionRunsAgent(sessionId)
}

async function attach(sessionId: string, _cols?: number, _rows?: number): Promise<void> {
  detach()
  const gen = ++attachGen
  attachedSessionId = sessionId
  // A newer attach has taken over; this one must not install its batcher or
  // allocate seqs behind the newer one's back.
  const superseded = (): boolean => gen !== attachGen
  const c = getClient()
  try {
    // Continue this session's seq monotonically — never reset to 0. On a cold
    // start (first time this bridge process attaches the session) prime the
    // counter from the highest seq still in Convex, so a desktop restart can't
    // drop seq below a web client's afterSeq cursor and strand it on an empty
    // getChunks. In-process re-attaches just keep climbing via ChunkSeq.
    if (!chunkSeq.has(sessionId)) {
      let head = -1
      try {
        head = await c.query(anyApi.remote.headSeq, { secret: DEVICE_SECRET, sessionId })
      } catch (err) {
        console.error('[remote-bridge] headSeq query failed', err)
      }
      if (superseded()) return
      chunkSeq.init(sessionId, typeof head === 'number' ? head : -1)
    }
    // Clear the old chunk log so a fresh viewer doesn't replay stale scrollback.
    // seq still climbs across this wipe, so an already-watching client receives
    // the new seed above its cursor and repaints (see ChunkSeq).
    await c.mutation(anyApi.remote.clearChunks, { secret: DEVICE_SECRET, sessionId })
    if (superseded()) return
    // Geometry-match the seed to the viewer (seed-geometry invariant: snapshot size
    // == client size, see remote-bridge-seed-geometry.test.ts):
    //  - web OWNS geometry → the phone renders 1:1 at webGeometry, so reflow the PTY
    //    to it (a nudged resize forces the TUI to re-wrap even if the width already
    //    coincides) and let it settle before snapshotting.
    //  - desktop owns → the phone is a scaling viewer that adopts the desktop's
    //    current size; snapshot at the live size, no resize, no reflow wait.
    if (ownership.owner === 'web' && ownership.webGeometry) {
      const { cols, rows } = ownership.webGeometry
      await reflowResize(
        (cc, rr) => getDaemonClient().resize(sessionId, cc, rr),
        cols,
        rows,
        undefined,
        RESEED_SETTLE_MS,
      )
      if (superseded()) return
      liveGeometry[sessionId] = { cols, rows }
    }
    const snapshot = await getDaemonClient().getSnapshot(sessionId)
    if (superseded()) return
    // The snapshot is now a fixed point in the byte stream, and everything the
    // PTY emits from here is on the far side of it: not in the seed, and never
    // re-sent — a TUI repaints differentially and will not redraw a frame it
    // believes it already drew. Until this fix the tap dropped every one of
    // those bytes (`!batcher → return`) while the seed made its round trip to
    // Convex, so the mirror's screen and the PTY's diverged for good: rows that
    // nothing ever erases (the second, frozen "Forming…" spinner), later partial
    // redraws landing at a cursor the client no longer agrees on (a stray block
    // caret outside the input box), and characters shuffled mid-line. Hold the
    // stream instead, and replay it on top of the seed — which reconstructs
    // exactly the daemon's own screen, since that is how the daemon builds it.
    pendingOutput = { gen, parts: [] }
    // Surface the snapshot's geometry immediately so a phone that attached before
    // any resize tap fired still sizes its xterm to match the seed.
    if (snapshot && snapshot.cols > 0 && snapshot.rows > 0) {
      liveGeometry[sessionId] = { cols: snapshot.cols, rows: snapshot.rows }
      pushState()
    }
    // Strip stale mouse-tracking enables from the rehydrate sequences so the
    // viewer doesn't inherit an armed mouse mode left behind by a killed TUI.
    const rehydrate = snapshot ? snapshot.rehydrateSequences.replace(MOUSE_ENABLE_RE, '') : ''
    const seed = snapshot ? snapshot.snapshotAnsi + rehydrate : ''
    if (seed) {
      // Mark the opening chunk as a seed so the web resets its xterm before
      // applying it — a re-seed cleanly repaints instead of layering onto stale
      // content.
      await c.mutation(anyApi.remote.appendChunk, {
        secret: DEVICE_SECRET, sessionId, seq: chunkSeq.next(sessionId), data: seed, seed: true,
      })
    }
    if (superseded()) return
    const live = createOutputBatcher({
      flushMs: FLUSH_MS,
      leading: true,
      maxBytes: MAX_BYTES,
      onFlush: (data) => {
        if (attachedSessionId !== sessionId || gen !== attachGen) return
        void c.mutation(anyApi.remote.appendChunk, {
          secret: DEVICE_SECRET, sessionId, seq: chunkSeq.next(sessionId), data,
        })
      },
    })
    // Release the hold into the batcher before publishing it, so the held bytes
    // keep their place at the head of the post-seed stream.
    const held = pendingOutput?.gen === gen ? pendingOutput.parts.join('') : ''
    if (pendingOutput?.gen === gen) pendingOutput = null
    batcher = live
    if (held) batcher.push(held)
  } finally {
    // Never leave this attach's hold armed: a hold with no batcher behind it
    // silently swallows the whole stream, which is the very failure above.
    if (pendingOutput?.gen === gen) pendingOutput = null
  }
}

function detach(): void {
  batcher?.flush()
  batcher?.dispose()
  batcher = null
  pendingOutput = null
  attachedSessionId = null
}

export function nativeChatStateChanged(): void {
  trackAgentContext(getMirrorSnapshot().sessions)
  chatReadyListener?.(getChatReadySessions())
  scheduleNativeChatPublish()
  pushState()
}
