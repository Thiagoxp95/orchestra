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
import { normalizeCreateWorktreePayload } from './remote-bridge-create-worktree'
import { normalizeSpawnInTreePayload } from './remote-bridge-spawn-in-tree'
import { createOutputBatcher, type OutputBatcher } from './remote-bridge-batcher'
import { createResubscriber, type Resubscriber } from './remote-bridge-resubscribe'
import { ChunkSeq } from './remote-bridge-seq'
import { buildLiveStatus } from './remote-bridge-livestatus'
import type { PersistedData } from '../shared/types'

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

// DECSET mouse-tracking enables. The snapshot's rehydrate sequences replay
// whatever modes were armed at capture time; if an agent TUI had mouse tracking
// on, a freshly attached web/phone client would inherit it and spray mouse
// reports ("35;31;18M") on every scroll. A live agent re-enables mouse tracking
// through the normal PTY stream, so dropping it from the seed is safe.
const MOUSE_ENABLE_RE = /\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1015)h/g

let client: ConvexClient | null = null
let commandSub: Resubscriber | null = null
let resubscribeTimer: ReturnType<typeof setInterval> | null = null
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

// Attached-session streaming state.
let attachedSessionId: string | null = null
// Monotonic, per-session chunk sequence that NEVER resets to 0 (see ChunkSeq).
// The web's afterSeq cursor only climbs and getChunks filters seq>afterSeq, so a
// reset would strand every already-watching client on an empty result forever —
// the "stuck terminal, must reopen the PWA" freeze.
const chunkSeq = new ChunkSeq()
let batcher: OutputBatcher | null = null

// Commands already applied (avoid re-processing across subscription refires).
const handledCommands = new Set<string>()

// Reconciliation: periodic heartbeat + wake/focus listeners (registered in
// startRemoteBridge, torn down in stopRemoteBridge).
let heartbeat: ReturnType<typeof setInterval> | null = null
const reconcile = (): void => { pushState() }

// Open (or re-open) the command subscription. Wrapped in a Resubscriber so the
// previous handle is always disposed first — a leaked one would deliver, and
// apply, every pending command twice.
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

export function startRemoteBridge(window: BrowserWindow): void {
  mainWindow = window
  if (!isEnabled()) {
    console.log('[remote-bridge] disabled (no DEVICE_SECRET) — running local-only')
    return
  }

  // Output tap → batched chunk append (attached session only).
  getDaemonClient().setTerminalDataTap((sessionId, data) => {
    if (sessionId !== attachedSessionId || !batcher) return
    batcher.push(data)
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
  window.on('focus', onFocus)
  powerMonitor.on('resume', onWake)
  powerMonitor.on('unlock-screen', onWake)
  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('lock-screen', onSuspend)

  // Initial state push.
  pushState()
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
type MirrorPayload = MirrorData & { workState?: Record<string, 'idle' | 'working'> }

// Last per-session work state the renderer computed (the same signal the desktop
// sidebar shimmers from). Cached so the heartbeat / focus / wake / status-tap
// pushes — which have no payload — still emit the full work state instead of the
// daemon tap's transition-only subset. See remote-bridge-livestatus.ts.
let rendererWorkState: Record<string, 'idle' | 'working'> = {}

/**
 * Realtime state mirror. Pushes the latest sanitized desktop state to Convex the
 * instant the renderer's store changes, decoupled from the 1s disk-persist
 * debounce. This is what makes a session spawned/closed on the desktop appear on
 * a phone within ~one frame instead of seconds later (the debounce was reset by
 * every store update, so a booting agent's update storm starved the old push).
 */
export function remoteBridgeOnMirror(data: MirrorPayload): void {
  if (!isEnabled()) return
  if (data.workState) rendererWorkState = data.workState
  pushState(data)
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
  // Prefer the fresh state handed in by the realtime mirror; fall back to disk
  // for the heartbeat / focus / wake / status-tap callers that have no payload.
  const data = fresh ?? loadPersistedData()
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
  // Merge the desktop's live PTY geometry into each session so the phone can
  // adopt it (see liveGeometry).
  const sessions = buildSessionMap(data.sessions)
  for (const [id, geo] of Object.entries(liveGeometry)) {
    if (sessions[id]) {
      sessions[id].cols = geo.cols
      sessions[id].rows = geo.rows
    }
  }
  // Overlay the renderer's authoritative work state onto the daemon tap so the
  // web shimmers EVERY working agent, not just the few the tap caught mid-
  // transition (see remote-bridge-livestatus.ts).
  const liveStatusOut = buildLiveStatus(Object.keys(data.sessions), liveStatus, rendererWorkState)
  void getClient().mutation(anyApi.remote.pushRemoteState, {
    secret: DEVICE_SECRET,
    workspaces: sanitizeWorkspaces(data.workspaces),
    sessions,
    liveStatus: liveStatusOut,
    activeWorkspaceId: data.activeWorkspaceId ?? null,
    activeSessionId: data.activeSessionId ?? null,
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
      // Intentionally ignored. The phone is a viewer that adopts the desktop's
      // geometry (see liveGeometry) and scales locally — it must never resize the
      // shared PTY, or it fights the desktop's ResizeObserver and garbles the
      // mirror. Older web clients still emit `resize`; dropping it here makes the
      // desktop immune regardless of the deployed web version.
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
  }
}

async function attach(sessionId: string, _cols?: number, _rows?: number): Promise<void> {
  detach()
  attachedSessionId = sessionId
  const c = getClient()
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
    chunkSeq.init(sessionId, typeof head === 'number' ? head : -1)
  }
  // Clear the old chunk log so a fresh viewer doesn't replay stale scrollback.
  // seq still climbs across this wipe, so an already-watching client receives
  // the new seed above its cursor and repaints (see ChunkSeq).
  await c.mutation(anyApi.remote.clearChunks, { secret: DEVICE_SECRET, sessionId })
  // The phone is a viewer and does NOT resize the shared PTY: it adopts the
  // desktop's current geometry instead (mirrored via liveGeometry → SafeSession,
  // applied to its xterm before it attaches). So snapshot at the live size — no
  // resize, no reflow wait. This keeps the seed-geometry invariant (snapshot size
  // == client size, see remote-bridge-seed-geometry.test.ts) without the
  // desktop/phone tug-of-war over the PTY width that left the mirror garbled.
  const snapshot = await getDaemonClient().getSnapshot(sessionId)
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
  batcher = createOutputBatcher({
    flushMs: FLUSH_MS,
    maxBytes: MAX_BYTES,
    onFlush: (data) => {
      if (attachedSessionId !== sessionId) return
      void c.mutation(anyApi.remote.appendChunk, {
        secret: DEVICE_SECRET, sessionId, seq: chunkSeq.next(sessionId), data,
      })
    },
  })
}

function detach(): void {
  batcher?.flush()
  batcher?.dispose()
  batcher = null
  attachedSessionId = null
}
