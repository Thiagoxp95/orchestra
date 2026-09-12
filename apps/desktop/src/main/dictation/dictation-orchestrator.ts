// Glue between Convex dictation rows and the Parakeet sidecar. Subscribes to
// pendingDictation; for the active utterance it polls audio chunks, feeds them
// to a single warm sidecar (model stays loaded between utterances), and on the
// final pass types the transcript into the agent PTY via the same daemon.write
// path remote.sendCommand uses. It does NOT press Enter — the text lands in the
// input like typing so the user can review/edit and submit it themselves.
//
// Every terminal outcome is written back to the dictation row: the phone has no
// other way to learn what happened, and a row that never reaches a terminal
// state leaves the button spinning until the client's own timeout.

import { anyApi } from 'convex/server'
import { DEVICE_SECRET } from '../convex-config'
import { getDaemonClient } from '../daemon-client'
import { getRemoteClient, isRemoteBridgeEnabled, registerRemoteSubscription, remoteTerminalInputGuard } from '../remote-bridge'
import { createResubscriber, type Resubscriber } from '../remote-bridge-resubscribe'
import { maxSeq, orderChunks, type RawChunk } from './dictation-chunks'
import { shouldFinalize } from './dictation-finalize'
import { spawnDictationSidecar, type DictationSidecarHandle } from './dictation-sidecar'

const POLL_MS = 150
// A cold sidecar pays the model load (several seconds) before its first pass;
// warm passes are ~1s. Well clear of both, and short enough that the phone's
// own 60s timeout is never the thing the user waits on.
const FINAL_TIMEOUT_MS = 45_000
// Rows we already finalized. The pendingDictation subscription can redeliver a
// row before our finalize lands, which would otherwise start a second pass over
// the same utterance and type the transcript twice.
const HANDLED_LIMIT = 32
// Most likely cause of a sidecar that dies immediately: voice setup was never
// run, so ~/.orchestra/voice-venv has no parakeet-mlx or no model.
const MODEL_MISSING_MESSAGE = 'Voice model not installed on the desktop.'

interface PendingRow {
  dictationId: string
  sessionId: string
  status: string
  chunkCount?: number
}

interface ActiveDictation {
  checkLease: () => void
  dictationId: string
  sessionId: string
  afterSeq: number
  received: number            // chunks fed to the sidecar
  expected: number | null     // chunkCount from the phone's endDictation
  ended: boolean              // phone released; drain remaining chunks then end()
  endedAt: number | null      // when we first saw 'ended' (drain deadline)
  endSentAt: number | null    // when we asked the sidecar to transcribe
  finalized: boolean          // guard against double-injection
}

let sidecar: DictationSidecarHandle | null = null
let current: ActiveDictation | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let pendingSub: Resubscriber | null = null
let unregisterSub: (() => void) | null = null
let started = false
let polling = false
let lastSidecarError: string | null = null
const handled: string[] = []

function markHandled(dictationId: string): void {
  handled.push(dictationId)
  if (handled.length > HANDLED_LIMIT) handled.shift()
}

function finalizeRow(dictationId: string, finalText: string): void {
  const c = getRemoteClient()
  void c
    .mutation(anyApi.remoteDictation.finalizeDictation, {
      secret: DEVICE_SECRET, dictationId, finalText,
    })
    .catch((err: unknown) => console.error('[dictation] finalizeDictation failed', err))
  void c
    .mutation(anyApi.remoteDictation.deleteDictationChunks, { secret: DEVICE_SECRET, dictationId })
    .catch((err: unknown) => console.error('[dictation] deleteDictationChunks failed', err))
}

function failRow(dictationId: string, error: string): void {
  const c = getRemoteClient()
  void c
    .mutation(anyApi.remoteDictation.failDictation, { secret: DEVICE_SECRET, dictationId, error })
    .catch((err: unknown) => console.error('[dictation] failDictation failed', err))
  void c
    .mutation(anyApi.remoteDictation.deleteDictationChunks, { secret: DEVICE_SECRET, dictationId })
    .catch((err: unknown) => console.error('[dictation] deleteDictationChunks failed', err))
}

// Ends the active utterance in a failed state and clears it, so the next one
// starts from a clean slate instead of inheriting a half-drained buffer.
function abortCurrent(message: string): void {
  if (!current || current.finalized) return
  const { dictationId } = current
  current.finalized = true
  current = null
  markHandled(dictationId)
  console.error('[dictation] aborting utterance', dictationId.split(':').at(-1), message)
  failRow(dictationId, message)
}

function ensureSidecar(): DictationSidecarHandle {
  if (sidecar) return sidecar
  const sc = spawnDictationSidecar()
  sc.onEvent((event) => {
    if (event.type === 'ready') {
      // Model loaded fine — a stale failure reason must not outlive it.
      lastSidecarError = null
    } else if (event.type === 'final') {
      // Match on the utterance id: a final can land after the user already
      // started the next hold, and attributing it to whatever is current would
      // type the old text into the new session and strand the new utterance.
      if (!current || current.finalized) return
      if (event.id && event.id !== current.dictationId) {
        console.warn('[dictation] dropping final for stale utterance', event.id?.split(':').at(-1))
        return
      }
      const { dictationId, sessionId, checkLease } = current
      current.finalized = true
      current = null
      markHandled(dictationId)
      const text = event.text.trim()
      // Type the transcript into the input WITHOUT pressing Enter, so the user
      // can review/edit and submit it themselves.
      if (text) {
        try {
          checkLease()
          getDaemonClient().write(sessionId, text)
        } catch (err) {
          console.error('[dictation] daemon write failed', err)
          failRow(dictationId, 'Could not reach the agent session.')
          return
        }
      }
      finalizeRow(dictationId, text)
    } else if (event.type === 'error') {
      console.error('[dictation] sidecar error', event.code, event.message)
      // A model_missing error arrives at startup, before any utterance exists.
      // Remember it so the crash that follows reports the real cause instead of
      // a generic "sidecar crashed".
      if (event.code === 'model_missing') lastSidecarError = MODEL_MISSING_MESSAGE
      if (!current || current.finalized) return
      if (event.id && event.id !== current.dictationId) return
      abortCurrent(
        event.code === 'model_missing' ? MODEL_MISSING_MESSAGE : 'Transcription failed on the desktop.',
      )
    }
  })
  sc.onStderr((line) => console.error('[dictation] sidecar stderr:', line))
  sc.onExit((code) => {
    console.error('[dictation] sidecar exited', code)
    sidecar = null
    // Whatever audio the dead process had buffered is gone; respawning and
    // feeding it the remaining chunks would transcribe a fragment.
    abortCurrent(lastSidecarError ?? 'Voice sidecar crashed on the desktop.')
  })
  sidecar = sc
  return sc
}

// Pick the newest pending row as the active utterance. A new dictationId
// supersedes any in-flight one (single user; serialize).
export function onPending(rows: PendingRow[]): void {
  // pendingDictation only carries recording/ended rows, so an active utterance
  // vanishing from the set means the phone cancelled it. Without this the
  // orchestrator polls a dead utterance forever — it never sees 'ended', so it
  // never finalizes and never releases.
  if (current && !current.finalized) {
    const stillPending = rows.some((r) => r.dictationId === current!.dictationId)
    if (!stillPending) abortCurrent('Dictation cancelled.')
  }

  const newest = rows[rows.length - 1]
  if (!newest) return
  if (handled.includes(newest.dictationId)) return
  if (!current || current.dictationId !== newest.dictationId) {
    // Supersede: the previous utterance will never complete now.
    if (current && !current.finalized) {
      abortCurrent('Superseded by a newer utterance.')
    }
    let checkLease: () => void
    try {
      const token = newest.dictationId.startsWith('stream:') ? newest.dictationId.split(':')[1] : undefined
      checkLease = remoteTerminalInputGuard(newest.sessionId, token)
    } catch {
      markHandled(newest.dictationId)
      failRow(newest.dictationId, 'Terminal control changed; dictation cancelled.')
      return
    }
    const sc = ensureSidecar()
    sc.reset(newest.dictationId)
    current = {
      checkLease,
      dictationId: newest.dictationId,
      sessionId: newest.sessionId,
      afterSeq: -1,
      received: 0,
      expected: null,
      ended: false,
      endedAt: null,
      endSentAt: null,
      finalized: false,
    }
  }
  if (current.dictationId === newest.dictationId && newest.status === 'ended') {
    if (!current.ended) current.endedAt = Date.now()
    current.ended = true
    if (typeof newest.chunkCount === 'number') current.expected = newest.chunkCount
  }
}

async function poll(): Promise<void> {
  // The interval fires every 150ms but a Convex round trip can exceed that.
  // Overlapping polls both read the same afterSeq and both feed the same chunks
  // to the model — duplicated audio, and a transcript that stutters words.
  if (polling) return
  if (!current || current.finalized) return
  polling = true
  try {
    const active = current
    // The sidecar has been told to transcribe; nothing left to feed.
    if (active.endSentAt !== null) {
      if (Date.now() - active.endSentAt >= FINAL_TIMEOUT_MS) {
        abortCurrent('Transcription timed out on the desktop.')
      }
      return
    }

    const c = getRemoteClient()
    let rows: RawChunk[] = []
    try {
      rows = (await c.query(anyApi.remoteDictation.getDictationChunks, {
        secret: DEVICE_SECRET,
        dictationId: active.dictationId,
        afterSeq: active.afterSeq,
      })) as RawChunk[]
    } catch (err) {
      console.error('[dictation] getDictationChunks failed', err)
      return
    }
    // The utterance may have been superseded or aborted while the query was in
    // flight; feeding its audio now would corrupt the next one's buffer.
    if (current !== active || active.finalized) return

    const ordered = orderChunks(rows, active.afterSeq)
    const sc = ensureSidecar()
    for (const ch of ordered) sc.sendAudio(ch.pcm)
    if (ordered.length > 0) {
      active.afterSeq = maxSeq(ordered, active.afterSeq)
      active.received += ordered.length
    }

    if (shouldFinalize(active, ordered.length, Date.now())) {
      active.endSentAt = Date.now()
      sc.end(active.dictationId)
    }
  } finally {
    polling = false
  }
}

export function startDictationOrchestrator(): void {
  if (started) return
  if (!isRemoteBridgeEnabled()) {
    console.log('[dictation] disabled (no DEVICE_SECRET)')
    return
  }
  started = true
  // Warm the model now rather than on the first hold. A cold Parakeet load runs
  // several seconds; paying it mid-utterance reads as "voice didn't work".
  try {
    ensureSidecar()
  } catch (err) {
    console.error('[dictation] failed to warm sidecar', err)
  }
  // Mirror remote-bridge: wrap onUpdate in a Resubscriber so the previous handle
  // is always disposed before a new one is created (a leak would double-apply).
  pendingSub = createResubscriber(() =>
    getRemoteClient().onUpdate(
      anyApi.remoteDictation.pendingDictation,
      { secret: DEVICE_SECRET },
      (rows: PendingRow[]) => onPending(rows),
      (err: Error) => console.error('[dictation] pendingDictation subscription error', err),
    ),
  )
  // This subscription is the only thing that tells us an utterance exists, and it
  // rides the bridge's client — so it dies whenever the bridge's push watchdog
  // rebuilds that client, and can wedge silently the same way the command loop
  // can. Subscribing once at startup meant the first rebuild left dictation deaf
  // for the rest of the run: the phone held the button, uploaded its audio, and
  // waited out its own 60s timeout ("No response from the desktop") while the
  // mirror stayed live, because the mirror gets rebuilt and this did not.
  // Registering re-opens it on the bridge's beats (rebuild, timer, focus, wake);
  // Convex refires the current pending list on every re-subscribe, so an
  // utterance that landed during the gap is still picked up.
  unregisterSub = registerRemoteSubscription(() => pendingSub?.resubscribe())
  pendingSub.resubscribe()
  pollTimer = setInterval(() => { void poll() }, POLL_MS)
  console.log('[dictation] orchestrator started')
}

export function stopDictationOrchestrator(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  // Unregister before stopping, or the bridge's next refresh re-opens the
  // subscription we just tore down.
  try { unregisterSub?.() } catch {}
  unregisterSub = null
  try { pendingSub?.stop() } catch {}
  pendingSub = null
  sidecar?.shutdown()
  sidecar?.kill()
  sidecar = null
  current = null
  polling = false
  lastSidecarError = null
  started = false
}
