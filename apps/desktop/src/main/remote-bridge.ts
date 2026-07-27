// Always-on bridge: mirrors sanitized workspace/session state to Convex and
// relays PTY I/O for the single session the web has attached. Inert if the
// DEVICE_SECRET env var is unset.

import { powerMonitor, type BrowserWindow } from 'electron'
import { ConvexClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { CONVEX_CLOUD_URL, DEVICE_SECRET } from './convex-config'
import { getDaemonClient } from './daemon-client'
import { loadPersistedData } from './persistence'
import { sanitizeWorkspaces, buildSessionMap } from './remote-bridge-sanitize'
import { resolveLinearIssues, getCachedLinearIssue } from './linear-mirror'
import { generateTicketDraft, createLinearTicket } from './ticket-orchestrator'
import { normalizeCreateWorktreePayload } from './remote-bridge-create-worktree'
import { normalizeSpawnInTreePayload } from './remote-bridge-spawn-in-tree'
import { normalizeSendImagePayload, saveRemoteImage, pruneRemoteImages } from './remote-bridge-image'
import {
  normalizeResumeSessionPayload,
  toRemoteAgentSessions,
} from './remote-bridge-agent-sessions'
import { listRecentAgentSessions } from './agent-session-history'
import { createOutputBatcher, type OutputBatcher } from './remote-bridge-batcher'
import { createResubscriber, type Resubscriber } from './remote-bridge-resubscribe'
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
import { buildLiveStatus } from './remote-bridge-livestatus'
import { AgentContextTracker, type TrackedAgentSession } from './agent-context-tracker'
import { getLastOutputAtBySession } from './terminal-output-buffer'
import { sanitizeUsage, usageFingerprint, type MirroredUsage } from './remote-bridge-usage'
import type { PersistedData, UsageSnapshot } from '../shared/types'

const FLUSH_MS = 50
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
let resubscribeTimer: ReturnType<typeof setInterval> | null = null
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
export async function remoteBridgeReclaimDesktop(cols?: number, rows?: number): Promise<void> {
  if (!isEnabled()) return
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

// Commands already applied (avoid re-processing across subscription refires).
const handledCommands = new Set<string>()

// Reconciliation: periodic heartbeat + wake/focus listeners (registered in
// startRemoteBridge, torn down in stopRemoteBridge).
let heartbeat: ReturnType<typeof setInterval> | null = null
const reconcile = (): void => { pushState() }

// Push-liveness watchdog (see PUSH_WATCHDOG_MS).
let pushWatchdog: ReturnType<typeof setInterval> | null = null
// When the last state push settled. Seeded on start so the first window is full.
let lastPushOkAt = 0

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
        (commands: any[]) => { void applyCommands(commands) },
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

  // Output tap → batched chunk append (attached session only).
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
    delete liveGeometry[sessionId]
    if (sessionId === attachedSessionId) detach()
    pushState()
  })

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

/**
 * The tracker is created on the first push (which is also the first moment the
 * bridge is enabled and has a session list) and re-aimed on every push, so it
 * follows sessions being spawned, closed, and swapped between agents.
 */
function trackAgentContext(sessions: Record<string, { processStatus: string; cwd: string }>): void {
  if (!contextTracker) {
    contextTracker = new AgentContextTracker({
      onChange: () => pushState(),
      resolveCodexTranscript: (sessionId) => resolveCodexTranscriptPath?.(sessionId) ?? null,
    })
  }
  const tracked: TrackedAgentSession[] = []
  for (const [sessionId, s] of Object.entries(sessions)) {
    if (s.processStatus !== 'claude' && s.processStatus !== 'codex') continue
    tracked.push({ sessionId, agent: s.processStatus, cwd: s.cwd })
  }
  contextTracker.setSessions(tracked)
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

export function remoteBridgeOnMirror(data: MirrorPayload): void {
  if (!isEnabled()) return
  if (data.workState) rendererWorkState = data.workState
  if (data.attention) rendererAttention = data.attention
  lastMirror = data
  pushState(data)
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
export function remoteBridgeOnResize(sessionId: string, cols: number, rows: number): void {
  if (!isEnabled()) return
  // While the web owns geometry the desktop is a scaling viewer and must NOT be
  // driving the PTY. A stray tap here (e.g. a late autofit reconcile racing the
  // owner flip) would clobber webGeometry and fight the phone — drop it.
  if (ownership.owner === 'web') return
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
  // Re-aim the context tracker at the current agent sessions before reading it,
  // so a session spawned in this very push is already being followed.
  trackAgentContext(sessions)
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
  )
  // Kick a fire-and-forget refresh of each worktree's linked Linear ticket; when a
  // cached value changes it re-pushes. sanitizeWorkspaces reads the cache synchronously.
  void resolveLinearIssues(data.workspaces, () => pushState())
  getClient()
    .mutation(anyApi.remote.pushRemoteState, {
      secret: DEVICE_SECRET,
      workspaces: sanitizeWorkspaces(data.workspaces, getCachedLinearIssue),
      sessions,
      liveStatus: liveStatusOut,
      activeWorkspaceId: data.activeWorkspaceId ?? null,
      activeSessionId: data.activeSessionId ?? null,
      geometryOwner: ownership.owner,
      geometryEpoch: ownership.epoch,
      usage: lastUsage,
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

async function applyCommands(commands: any[]): Promise<void> {
  const c = getClient()
  for (const cmd of commands) {
    const id = cmd._id as string
    if (handledCommands.has(id)) continue
    handledCommands.add(id)
    try {
      await applyOne(cmd)
    } catch (err) {
      console.error('[remote-bridge] command failed', cmd.kind, err)
    } finally {
      try {
        await c.mutation(anyApi.remote.deleteCommand, { secret: DEVICE_SECRET, id: cmd._id })
      } catch (err) {
        console.error('[remote-bridge] deleteCommand failed', err)
      }
      handledCommands.delete(id)
    }
  }
}

async function applyOne(cmd: any): Promise<void> {
  const daemon = getDaemonClient()
  switch (cmd.kind) {
    case 'attach':
      await attach(cmd.sessionId, Number(cmd.payload?.cols), Number(cmd.payload?.rows))
      break
    case 'detach':
      detach()
      break
    case 'write':
      daemon.write(cmd.sessionId, String(cmd.payload?.data ?? ''))
      break
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
      await daemon.kill(cmd.sessionId)
      // Killing the PTY leaves the session in the renderer store, so the next
      // state push re-adds the row and the web's swipe-to-trash looks inert.
      // Mirror the desktop "close" (killTerminal + deleteSession) by forwarding
      // the removal to the renderer; the resulting persist re-pushes state
      // without the session and the row disappears.
      mainWindow?.webContents.send('remote-kill-session', cmd.sessionId)
      break
    case 'runAction':
      // runAction lives in the renderer store; forward to it like webhooks do.
      mainWindow?.webContents.send('remote-run-action', {
        workspaceId: String(cmd.payload?.workspaceId ?? ''),
        actionId: String(cmd.payload?.actionId ?? ''),
      })
      break
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
    case 'sendImage': {
      // Phone screenshot: download the blob the web uploaded to Convex storage,
      // land it on disk, and type its path (plus a trailing space, no Enter)
      // into the target session so the user can keep composing from the phone.
      const { storageId, mime } = normalizeSendImagePayload(cmd.payload)
      if (!storageId || !cmd.sessionId) break
      const c = getClient()
      const url = await c.query(anyApi.remote.imageUrl, { secret: DEVICE_SECRET, storageId })
      if (!url) throw new Error(`sendImage: no URL for storageId ${storageId}`)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`sendImage: download failed (${res.status})`)
      const filePath = await saveRemoteImage(new Uint8Array(await res.arrayBuffer()), mime)
      daemon.write(cmd.sessionId, `${filePath} `)
      // Blob delivered — drop it. A miss here is mopped up by pruneRemote.
      await c.mutation(anyApi.remote.deleteImage, { secret: DEVICE_SECRET, storageId })
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
