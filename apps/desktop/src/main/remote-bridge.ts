// Always-on bridge: mirrors sanitized workspace/session state to Convex and
// relays PTY I/O for the single session the web has attached. Inert if the
// DEVICE_SECRET env var is unset.

import { ConvexClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { CONVEX_CLOUD_URL, DEVICE_SECRET } from './convex-config'
import { getDaemonClient } from './daemon-client'
import { loadPersistedData } from './persistence'
import { sanitizeWorkspaces, buildSessionMap } from './remote-bridge-sanitize'
import { createOutputBatcher, type OutputBatcher } from './remote-bridge-batcher'
import type { PersistedData } from '../shared/types'

const FLUSH_MS = 50
const MAX_BYTES = 16 * 1024

let client: ConvexClient | null = null
let unsubscribeCommands: (() => void) | null = null

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

export function startRemoteBridge(): void {
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
  getDaemonClient().setClaudeWorkStateHandler((sessionId, state) => {
    liveStatus[sessionId] = {
      ...liveStatus[sessionId],
      work: state === 'idle' ? 'idle' : 'working',
    }
    pushState()
  })
  getDaemonClient().setTerminalExitHandler((sessionId) => {
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
      void c.mutation(anyApi.remote.deleteCommand, { secret: DEVICE_SECRET, id: cmd._id })
      handledCommands.delete(id)
    }
  }
}

async function applyOne(cmd: any): Promise<void> {
  const daemon = getDaemonClient()
  switch (cmd.kind) {
    case 'attach':
      await attach(cmd.sessionId)
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
      break
  }
}

async function attach(sessionId: string): Promise<void> {
  detach()
  attachedSessionId = sessionId
  seq = 0
  const c = getClient()
  // Reset the chunk log for a clean re-seed.
  await c.mutation(anyApi.remote.clearChunks, { secret: DEVICE_SECRET, sessionId })
  // Seed with the current screen so the web renders identically immediately.
  const snapshot = await getDaemonClient().getSnapshot(sessionId)
  const seed = snapshot ? snapshot.snapshotAnsi + snapshot.rehydrateSequences : ''
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
