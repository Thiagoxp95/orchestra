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
let seq = 0
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

// Wake path (focus / resume / unlock): push the latest state AND refresh the
// command subscription, since a stale socket is most likely right after the
// machine wakes — exactly when the user reaches for their phone.
const onWake = (): void => {
  reconcile()
  subscribeCommands()
}

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
  window.on('focus', onWake)
  powerMonitor.on('resume', onWake)
  powerMonitor.on('unlock-screen', onWake)

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
  mainWindow?.off('focus', onWake)
  powerMonitor.off('resume', onWake)
  powerMonitor.off('unlock-screen', onWake)
  batcher?.dispose()
  batcher = null
  attachedSessionId = null
}

export function remoteBridgeOnStatePersisted(_data: PersistedData): void {
  if (!isEnabled()) return
  pushState()
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

function pushState(): void {
  if (!isEnabled()) return
  const data = loadPersistedData()
  // Drop liveStatus / liveGeometry entries for sessions that no longer exist.
  for (const id of Object.keys(liveStatus)) {
    if (!(id in data.sessions)) delete liveStatus[id]
  }
  for (const id of Object.keys(liveGeometry)) {
    if (!(id in data.sessions)) delete liveGeometry[id]
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
  void getClient().mutation(anyApi.remote.pushRemoteState, {
    secret: DEVICE_SECRET,
    workspaces: sanitizeWorkspaces(data.workspaces),
    sessions,
    liveStatus,
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
  seq = 0
  const c = getClient()
  // Reset the chunk log for a clean re-seed.
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
    await c.mutation(anyApi.remote.appendChunk, { secret: DEVICE_SECRET, sessionId, seq: seq++, data: seed })
  }
  batcher = createOutputBatcher({
    flushMs: FLUSH_MS,
    maxBytes: MAX_BYTES,
    onFlush: (data) => {
      if (attachedSessionId !== sessionId) return
      void c.mutation(anyApi.remote.appendChunk, { secret: DEVICE_SECRET, sessionId, seq: seq++, data })
    },
  })
}

function detach(): void {
  batcher?.flush()
  batcher?.dispose()
  batcher = null
  attachedSessionId = null
}
