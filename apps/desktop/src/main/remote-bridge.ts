// Always-on bridge: mirrors sanitized workspace/session state to Convex and
// relays PTY I/O for the single session the web has attached. Inert if the
// DEVICE_SECRET env var is unset.

import type { BrowserWindow } from 'electron'
import { ConvexClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { CONVEX_CLOUD_URL, DEVICE_SECRET } from './convex-config'
import { getDaemonClient } from './daemon-client'
import { loadPersistedData } from './persistence'
import { sanitizeWorkspaces, buildSessionMap } from './remote-bridge-sanitize'
import { normalizeCreateWorktreePayload } from './remote-bridge-create-worktree'
import { normalizeSpawnInTreePayload } from './remote-bridge-spawn-in-tree'
import { createOutputBatcher, type OutputBatcher } from './remote-bridge-batcher'
import type { PersistedData } from '../shared/types'
import { snapshotWhenSettled } from './remote-bridge-snapshot'

const FLUSH_MS = 50
const MAX_BYTES = 16 * 1024

// DECSET mouse-tracking enables. The snapshot's rehydrate sequences replay
// whatever modes were armed at capture time; if an agent TUI had mouse tracking
// on, a freshly attached web/phone client would inherit it and spray mouse
// reports ("35;31;18M") on every scroll. A live agent re-enables mouse tracking
// through the normal PTY stream, so dropping it from the seed is safe.
const MOUSE_ENABLE_RE = /\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1015)h/g

let client: ConvexClient | null = null
let unsubscribeCommands: (() => void) | null = null
// Renderer handle, used to forward remote action triggers (runAction lives in
// the renderer store, mirroring the webhook-run-action path).
let mainWindow: BrowserWindow | null = null

// Live status overlaid on the mirrored state.
const liveStatus: Record<string, { work: 'idle' | 'working'; exited?: boolean; label?: string }> = {}

// Attached-session streaming state.
let attachedSessionId: string | null = null
let seq = 0
let batcher: OutputBatcher | null = null

// Commands already applied (avoid re-processing across subscription refires).
const handledCommands = new Set<string>()

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
  const c = getClient()

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
    if (sessionId === attachedSessionId) detach()
    pushState()
  })

  // Command loop.
  unsubscribeCommands = c.onUpdate(
    anyApi.remote.pendingCommands,
    { secret: DEVICE_SECRET },
    (commands: any[]) => { void applyCommands(commands) },
  )

  // Initial state push.
  pushState()
  console.log('[remote-bridge] started')
}

export function stopRemoteBridge(): void {
  unsubscribeCommands?.()
  unsubscribeCommands = null
  batcher?.dispose()
  batcher = null
  attachedSessionId = null
}

export function remoteBridgeOnStatePersisted(_data: PersistedData): void {
  if (!isEnabled()) return
  pushState()
}

function pushState(): void {
  if (!isEnabled()) return
  const data = loadPersistedData()
  // Drop liveStatus entries for sessions that no longer exist.
  for (const id of Object.keys(liveStatus)) {
    if (!(id in data.sessions)) delete liveStatus[id]
  }
  void getClient().mutation(anyApi.remote.pushRemoteState, {
    secret: DEVICE_SECRET,
    workspaces: sanitizeWorkspaces(data.workspaces),
    sessions: buildSessionMap(data.sessions),
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
      await daemon.resize(cmd.sessionId, Number(cmd.payload?.cols), Number(cmd.payload?.rows))
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

async function attach(sessionId: string, cols?: number, rows?: number): Promise<void> {
  detach()
  attachedSessionId = sessionId
  seq = 0
  const c = getClient()
  // Reset the chunk log for a clean re-seed.
  await c.mutation(anyApi.remote.clearChunks, { secret: DEVICE_SECRET, sessionId })
  // Resize the session to the viewer's terminal size *before* snapshotting so the
  // seeded screen serializes at the web's width — otherwise a snapshot captured at
  // the desktop's wider PTY wraps into garbage when replayed on a narrow phone.
  const didResize = Number.isFinite(cols) && Number.isFinite(rows) && cols! > 0 && rows! > 0
  if (didResize) {
    try {
      await getDaemonClient().resize(sessionId, cols!, rows!)
    } catch (err) {
      console.error('[remote-bridge] resize-before-snapshot failed', err)
    }
  }
  // Seed with the current screen so the web renders identically immediately.
  // After a resize the TUI repaints asynchronously on SIGWINCH, so wait for the
  // mirrored screen to settle — an immediate snapshot seeds a half-reflowed
  // frame that the live redraw then overlays (ghosted/doubled screen). With no
  // resize there's no reflow, so snapshot immediately.
  const snapshot = didResize
    ? await snapshotWhenSettled(() => getDaemonClient().getSnapshot(sessionId), {
        minSettleMs: 150,
        intervalMs: 70,
        timeoutMs: 800,
      })
    : await getDaemonClient().getSnapshot(sessionId)
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
