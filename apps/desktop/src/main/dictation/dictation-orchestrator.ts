// Glue between Convex dictation rows and the Parakeet sidecar. Subscribes to
// pendingDictation; for the active utterance it polls audio chunks, feeds them
// to a single warm sidecar (model stays loaded between utterances), and on the
// final pass types the transcript into the agent PTY via the same daemon.write
// path remote.sendCommand uses. It does NOT press Enter — the text lands in the
// input like typing so the user can review/edit and submit it themselves.

import { anyApi } from 'convex/server'
import { DEVICE_SECRET } from '../convex-config'
import { getDaemonClient } from '../daemon-client'
import { getRemoteClient, isRemoteBridgeEnabled } from '../remote-bridge'
import { createResubscriber, type Resubscriber } from '../remote-bridge-resubscribe'
import { maxSeq, orderChunks, type RawChunk } from './dictation-chunks'
import { spawnDictationSidecar, type DictationSidecarHandle } from './dictation-sidecar'

const POLL_MS = 150

interface ActiveDictation {
  dictationId: string
  sessionId: string
  afterSeq: number
  ended: boolean      // web pressed release; drain remaining chunks then end()
  finalized: boolean  // sidecar emitted final; guard against double-injection
}

let sidecar: DictationSidecarHandle | null = null
let current: ActiveDictation | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let pendingSub: Resubscriber | null = null
let started = false

function ensureSidecar(): DictationSidecarHandle {
  if (sidecar) return sidecar
  const sc = spawnDictationSidecar()
  sc.onEvent((event) => {
    if (event.type === 'final') {
      if (current && !current.finalized) {
        const { dictationId, sessionId, afterSeq } = current
        current.finalized = true
        const text = event.text.trim()
        // Type the transcript into the input WITHOUT pressing Enter, so the user
        // can review/edit and submit it themselves.
        if (text) getDaemonClient().write(sessionId, text)
        const c = getRemoteClient()
        void c.mutation(anyApi.remoteDictation.finalizeDictation, {
          secret: DEVICE_SECRET, dictationId, finalText: text,
        })
        void c.mutation(anyApi.remoteDictation.deleteDictationChunks, {
          secret: DEVICE_SECRET, dictationId, throughSeq: afterSeq,
        })
        current = null
      }
    } else if (event.type === 'error') {
      console.error('[dictation] sidecar error', event.code, event.message)
    }
  })
  sc.onStderr((line) => console.error('[dictation] sidecar stderr:', line))
  sc.onExit((code) => {
    console.error('[dictation] sidecar exited', code)
    sidecar = null
  })
  sidecar = sc
  return sc
}

// Pick the newest pending row as the active utterance. A new dictationId
// supersedes any in-flight one (single user; serialize).
function onPending(rows: Array<{ dictationId: string; sessionId: string; status: string }>): void {
  const newest = rows[rows.length - 1]
  if (!newest) return
  if (!current || current.dictationId !== newest.dictationId) {
    const sc = ensureSidecar()
    sc.reset()
    current = {
      dictationId: newest.dictationId,
      sessionId: newest.sessionId,
      afterSeq: -1,
      ended: false,
      finalized: false,
    }
  }
  if (current && current.dictationId === newest.dictationId && newest.status === 'ended') {
    current.ended = true
  }
}

async function poll(): Promise<void> {
  if (!current || current.finalized) return
  const c = getRemoteClient()
  let rows: RawChunk[] = []
  try {
    rows = (await c.query(anyApi.remoteDictation.getDictationChunks, {
      secret: DEVICE_SECRET,
      dictationId: current.dictationId,
      afterSeq: current.afterSeq,
    })) as RawChunk[]
  } catch (err) {
    console.error('[dictation] getDictationChunks failed', err)
    return
  }
  const ordered = orderChunks(rows, current.afterSeq)
  const sc = ensureSidecar()
  for (const ch of ordered) sc.sendAudio(ch.pcm)
  if (ordered.length > 0) current.afterSeq = maxSeq(ordered, current.afterSeq)
  // Once the phone has released AND this poll drained everything, finalize.
  if (current.ended && ordered.length === 0) {
    current.ended = false // guard: only fire end() once
    sc.end()
  }
}

export function startDictationOrchestrator(): void {
  if (started) return
  if (!isRemoteBridgeEnabled()) {
    console.log('[dictation] disabled (no DEVICE_SECRET)')
    return
  }
  started = true
  // Mirror remote-bridge: wrap onUpdate in a Resubscriber so the previous handle
  // is always disposed before a new one is created (a leak would double-apply).
  pendingSub = createResubscriber(() =>
    getRemoteClient().onUpdate(
      anyApi.remoteDictation.pendingDictation,
      { secret: DEVICE_SECRET },
      (rows: Array<{ dictationId: string; sessionId: string; status: string }>) => onPending(rows),
      (err: Error) => console.error('[dictation] pendingDictation subscription error', err),
    ),
  )
  pendingSub.resubscribe()
  pollTimer = setInterval(() => { void poll() }, POLL_MS)
  console.log('[dictation] orchestrator started')
}

export function stopDictationOrchestrator(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  try { pendingSub?.stop() } catch {}
  pendingSub = null
  sidecar?.shutdown()
  sidecar?.kill()
  sidecar = null
  current = null
  started = false
}
