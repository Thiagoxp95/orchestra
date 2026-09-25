'use client'
import { api, useQuery, useSync } from '../lib/sync'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  floatTo16BitPCM,
  int16ToBase64,
  peakLevel,
  samplesPerChunk,
  StreamResampler,
  TARGET_SAMPLE_RATE,
} from '../lib/dictation'
import { assertInputLease, captureInputLease, makeDictationId, type InputLeaseGetter } from '../lib/terminal-stream/input-lease'
import { CONNECTION_SLOW_ERROR, PendingAudioBudget } from '../lib/dictation-budget'

export type DictationStatus = 'idle' | 'starting' | 'recording' | 'processing' | 'error'

export interface DictationControls {
  status: DictationStatus
  /** True while the mic is open — drives the button's pressed/pulsing state. */
  isDictating: boolean
  /** True from button release until the desktop reports a result. */
  isProcessing: boolean
  error: string | null
  start: () => void
  stop: () => void
  cancel: () => void
  /**
   * Live mic loudness, 0..1, for a VU meter. Deliberately NOT React state: a
   * 60fps setState would re-render the whole pane on every animation frame.
   * Poll it from a requestAnimationFrame loop; returns 0 when the mic is shut.
   */
  getLevel: () => number
}

// Hard cap so a stuck button on the street can't record forever.
const MAX_HOLD_MS = 60_000
// A hold shorter than this is a mis-tap, not an utterance. Cancel it instead of
// shipping ~100ms of audio for the model to hallucinate a word out of.
const MIN_HOLD_MS = 350
// How long to wait for the desktop to transcribe before giving up. Covers a
// cold sidecar (model load) plus a long utterance.
const RESULT_TIMEOUT_MS = 60_000
// Below this peak the capture is digital silence — a muted mic, or iOS handing
// back a silent track because another app holds the audio session.
const SILENCE_PEAK = 0.002
// The worklet's flush ack round-trips through the audio thread. If it doesn't
// come back promptly the graph is already dead; don't hang the release on it.
const FLUSH_ACK_TIMEOUT_MS = 150

const CHUNK_SAMPLES = samplesPerChunk(TARGET_SAMPLE_RATE)
const UPLOAD_ATTEMPTS = 3

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function useDictation(
  sessionId: string,
  /**
   * Receives the transcript once the desktop reports it. The desktop has ALSO
   * typed the text into the PTY by then — that is the terminal's whole flow — so
   * this is purely for surfacing what was heard.
   */
  onFinalText?: (text: string) => void,
  getInputLease?: InputLeaseGetter,
): DictationControls {
  const sync = useSync()
  const onFinalTextRef = useRef(onFinalText)
  const getInputLeaseRef = useRef(getInputLease)
  useLayoutEffect(() => {
    onFinalTextRef.current = onFinalText
    getInputLeaseRef.current = getInputLease
  }, [onFinalText, getInputLease])
  const [status, setStatus] = useState<DictationStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  // The row the phone is waiting on a transcript for. The desktop writes the
  // terminal status there; it is our only feedback that anything happened.
  const [watchId, setWatchId] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const nodeRef = useRef<AudioWorkletNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const meterBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const resamplerRef = useRef<StreamResampler | null>(null)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const flushAckRef = useRef<(() => void) | null>(null)

  const accRef = useRef<Float32Array[]>([])
  const accLenRef = useRef(0)
  const seqRef = useRef(0)
  const peakRef = useRef(0)
  const startedAtRef = useRef(0)

  // Orca's concurrency model (mobile/src/hooks/use-mobile-dictation.ts, MIT):
  // a generation counter invalidates any async continuation whose start/stop has
  // since been superseded, an id ref is the real source of truth (React state
  // lags a fast tap by a render), and an explicit gate decides whether mic
  // callbacks may enqueue. Without these, releasing the button before
  // getUserMedia resolved left the mic open with nothing able to close it.
  const generationRef = useRef(0)
  const activeIdRef = useRef<string | null>(null)
  const processingIdRef = useRef<string | null>(null)
  const acceptingChunksRef = useRef(false)
  const stoppingRef = useRef(false)
  const pendingChunksRef = useRef<Set<Promise<unknown>>>(new Set())
  const budgetRef = useRef(new PendingAudioBudget())

  const sessionIdRef = useRef(sessionId)
  useLayoutEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  const releaseWakeLock = useCallback(() => {
    const lock = wakeLockRef.current
    wakeLockRef.current = null
    if (lock) void lock.release().catch(() => undefined)
  }, [])

  /** Releases the mic hardware. Upload bookkeeping is left intact. */
  const stopCapture = useCallback(() => {
    try {
      nodeRef.current?.disconnect()
    } catch {
      // Disconnecting an already-dead graph must not strand the MediaStream.
    }
    nodeRef.current = null
    analyserRef.current = null
    flushAckRef.current = null
    void ctxRef.current?.close().catch(() => undefined)
    ctxRef.current = null
    // Until these stop, the phone keeps showing the recording indicator.
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    resamplerRef.current = null
    accRef.current = []
    accLenRef.current = 0
  }, [])

  /** Full teardown: hardware, in-flight upload bookkeeping, and the wake lock. */
  const closeAudio = useCallback(() => {
    acceptingChunksRef.current = false
    stoppingRef.current = false
    pendingChunksRef.current.clear()
    budgetRef.current.reset()
    stopCapture()
    releaseWakeLock()
  }, [releaseWakeLock, stopCapture])

  const fail = useCallback((message: string) => {
    setError(message)
    setStatus('error')
    setWatchId(null)
  }, [])

  // Fire-and-forget cancel so a dropped utterance doesn't sit in `pendingDictation`
  // on the desktop waiting for audio that will never arrive.
  const cancelRow = useCallback(
    (dictationId: string | null) => {
      if (!dictationId) return
      void sync
        .call(api.remoteDictation.cancelDictation, { dictationId })
        .catch(() => undefined)
    },
    [sync],
  )

  const cancel = useCallback(() => {
    const id = activeIdRef.current
    const processingId = processingIdRef.current ?? watchId
    processingIdRef.current = null
    generationRef.current += 1
    activeIdRef.current = null
    closeAudio()
    cancelRow(id)
    if (processingId && processingId !== id) cancelRow(processingId)
    setWatchId(null)
    setStatus('idle')
    setError(null)
  }, [cancelRow, closeAudio, watchId])

  // Aborts the utterance locally and surfaces `message`. Used by the paths that
  // can fail mid-capture (upload error, backpressure).
  const abort = useCallback(
    (message: string) => {
      const id = activeIdRef.current
      generationRef.current += 1
      activeIdRef.current = null
      closeAudio()
      cancelRow(id)
      fail(message)
    },
    [cancelRow, closeAudio, fail],
  )

  const uploadChunk = useCallback(
    async (dictationId: string, seq: number, pcm: string): Promise<void> => {
      let lastErr: unknown
      for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt++) {
        // Abandon retries once this utterance is no longer the live one.
        if (activeIdRef.current !== dictationId) return
        try {
          await sync.call(api.remoteDictation.appendDictationChunk, {
            dictationId,
            seq,
            pcm,
          })
          return
        } catch (err) {
          lastErr = err
          if (attempt < UPLOAD_ATTEMPTS - 1) await delay(150 * 2 ** attempt)
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error('chunk upload failed')
    },
    [sync],
  )

  // Drains the accumulator into one upload. Tracked in `pendingChunks` so stop()
  // can wait for every chunk to be acknowledged before it ends the utterance —
  // ending first meant the backend rejected the tail (the row is no longer
  // 'recording'), silently truncating the last word or two.
  const flushChunk = useCallback(() => {
    const dictationId = activeIdRef.current
    if (!dictationId || accLenRef.current === 0) return
    const merged = new Float32Array(accLenRef.current)
    let off = 0
    for (const a of accRef.current) {
      merged.set(a, off)
      off += a.length
    }
    accRef.current = []
    accLenRef.current = 0

    const pcm = floatTo16BitPCM(merged)
    const byteLength = pcm.byteLength
    if (!budgetRef.current.tryReserve(byteLength)) {
      abort(CONNECTION_SLOW_ERROR)
      return
    }
    const seq = seqRef.current++
    const upload = uploadChunk(dictationId, seq, int16ToBase64(pcm))
      .catch((err: unknown) => {
        if (activeIdRef.current !== dictationId) return
        abort(err instanceof Error ? err.message : 'Failed to upload audio')
      })
      .finally(() => {
        budgetRef.current.release(byteLength)
        pendingChunksRef.current.delete(upload)
      })
    pendingChunksRef.current.add(upload)
  }, [abort, uploadChunk])

  // Asks the worklet to post its partial block and waits for the ack. The
  // worklet batches 2048 samples before posting, so without this the final
  // ~128ms — usually the end of the last word — dies with the audio graph.
  const flushWorklet = useCallback(
    () =>
      new Promise<void>((resolve) => {
        const node = nodeRef.current
        if (!node) {
          resolve()
          return
        }
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          flushAckRef.current = null
          resolve()
        }
        const timer = setTimeout(finish, FLUSH_ACK_TIMEOUT_MS)
        flushAckRef.current = finish
        try {
          node.port.postMessage('flush')
        } catch {
          finish()
        }
      }),
    [],
  )

  const stop = useCallback(() => {
    const dictationId = activeIdRef.current
    if (!dictationId || stoppingRef.current) return
    // Bump first, unconditionally: this is what tells an in-flight start() that
    // the button is already up. Returning early here (e.g. because recording had
    // not committed yet) let start() finish opening a mic nothing would close.
    const generation = generationRef.current + 1
    generationRef.current = generation

    // Released before the mic actually opened — permission prompt, worklet load,
    // or just a fast tap. Nothing was captured, so this is a cancel.
    if (!acceptingChunksRef.current) {
      activeIdRef.current = null
      closeAudio()
      cancelRow(dictationId)
      setWatchId(null)
      setStatus('idle')
      return
    }

    stoppingRef.current = true
    processingIdRef.current = dictationId
    const heldMs = Date.now() - startedAtRef.current
    setStatus('processing')

    void (async () => {
      // Keep the chunk gate open across the flush so the worklet's last block is
      // still accepted; the generation bump above already blocks a second stop.
      await flushWorklet()
      acceptingChunksRef.current = false
      flushChunk()
      stopCapture()

      if (heldMs < MIN_HOLD_MS || peakRef.current < SILENCE_PEAK) {
        const silent = peakRef.current < SILENCE_PEAK
        activeIdRef.current = null
        closeAudio()
        cancelRow(dictationId)
        setWatchId(null)
        fail(
          silent
            ? 'No sound from the mic — check the microphone permission.'
            : 'Hold the button while you speak.',
        )
        return
      }

      const chunkCount = seqRef.current
      // Wait for every chunk to be acknowledged before ending: `endDictation`
      // flips the row out of 'recording', after which appends are rejected.
      await Promise.allSettled(Array.from(pendingChunksRef.current))
      activeIdRef.current = null
      closeAudio()
      // Deliberately not guarded by the generation check: whatever the user does
      // next, this row must reach a terminal state, or the desktop keeps polling
      // an utterance nobody will ever finish.
      try {
        await sync.call(api.remoteDictation.endDictation, {
          dictationId,
          chunkCount,
        })
      } catch (err) {
        if (generationRef.current !== generation) return
        fail(err instanceof Error ? err.message : 'Failed to finish dictation')
        return
      }
      // Only the UI state is superseded by a newer utterance.
      if (generationRef.current !== generation) return
      setWatchId(dictationId)
    })()
  }, [cancelRow, closeAudio, sync, fail, flushChunk, flushWorklet, stopCapture])

  const start = useCallback(() => {
    if (activeIdRef.current) return
    let leaseToken: string | undefined
    try { leaseToken = captureInputLease(getInputLeaseRef.current) }
    catch { fail('Activate this view to control the terminal.'); return }
    const generation = generationRef.current + 1
    generationRef.current = generation
    const dictationId = makeDictationId(crypto.randomUUID(), leaseToken)
    activeIdRef.current = dictationId
    seqRef.current = 0
    peakRef.current = 0
    accRef.current = []
    accLenRef.current = 0
    stoppingRef.current = false
    pendingChunksRef.current.clear()
    budgetRef.current.reset()
    setError(null)
    setWatchId(null)
    setStatus('starting')

    // Every `await` below is a point where the user may already have released
    // the button. `superseded()` is checked after each one so a late resolution
    // can never re-open a mic that stop()/cancel() has closed.
    const superseded = () => {
      if (generationRef.current !== generation) return true
      try { assertInputLease(getInputLeaseRef.current, leaseToken) }
      catch { cancel(); return true }
      return false
    }

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        if (superseded()) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream

        // Ask for 16k directly so the browser's own resampler does the work; its
        // filtering beats anything we do by hand. Safari/Chrome may ignore the
        // hint and hand back the hardware rate, so check what we actually got.
        const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
        ctxRef.current = ctx
        resamplerRef.current =
          ctx.sampleRate === TARGET_SAMPLE_RATE ? null : new StreamResampler(ctx.sampleRate)

        await ctx.audioWorklet.addModule('/dictation-worklet.js')
        if (superseded()) return
        // iOS hands back a suspended context when the gesture isn't recognised as
        // user activation; without this the worklet never pulls and the whole
        // utterance is silence.
        if (ctx.state === 'suspended') await ctx.resume()
        if (superseded()) return

        const source = ctx.createMediaStreamSource(stream)
        const node = new AudioWorkletNode(ctx, 'pcm-capture')
        nodeRef.current = node
        node.port.onmessage = (ev: MessageEvent<Float32Array | string>) => {
          if (typeof ev.data === 'string') {
            if (ev.data === 'flushed') flushAckRef.current?.()
            return
          }
          if (!acceptingChunksRef.current || activeIdRef.current !== dictationId) return
          const resampler = resamplerRef.current
          const block = resampler ? resampler.process(ev.data) : ev.data
          if (block.length === 0) return
          const p = peakLevel(block)
          if (p > peakRef.current) peakRef.current = p
          // The resampler returns a subarray view over its scratch buffer; copy.
          accRef.current.push(block.slice())
          accLenRef.current += block.length
          if (accLenRef.current >= CHUNK_SAMPLES) flushChunk()
        }
        // The analyser is a pass-through tap spliced into the capture chain, so
        // it is pulled by the same graph the worklet is (a dangling analyser
        // isn't guaranteed to be processed) and the meter reads the exact audio
        // being uploaded. The worklet's own 128ms batches are far too coarse to
        // animate from.
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        analyser.smoothingTimeConstant = 0.6
        analyserRef.current = analyser
        meterBufRef.current = new Uint8Array(analyser.fftSize)
        source.connect(analyser)
        analyser.connect(node)
        // Worklets only pull when connected to a destination; a zero-gain sink
        // keeps the graph running without echoing the mic to the speakers.
        const sink = ctx.createGain()
        sink.gain.value = 0
        node.connect(sink).connect(ctx.destination)

        // Create the row *before* opening the gate. The backend rejects chunks
        // for a dictation it has never seen, so uploading while this was still
        // in flight quietly ate the first fraction of a second of speech.
        await sync.call(api.remoteDictation.startDictation, {
          dictationId,
          sessionId: sessionIdRef.current,
        })
        if (superseded()) {
          cancelRow(dictationId)
          return
        }

        // Best-effort: a screen lock mid-utterance suspends the page and loses
        // both the audio and the pending uploads.
        try {
          wakeLockRef.current = (await navigator.wakeLock?.request('screen')) ?? null
        } catch {
          // Unsupported or denied (iOS < 16.4) — recording still works.
        }
        if (superseded()) {
          releaseWakeLock()
          return
        }

        startedAtRef.current = Date.now()
        acceptingChunksRef.current = true
        setStatus('recording')
      } catch (err) {
        if (superseded()) return
        activeIdRef.current = null
        closeAudio()
        cancelRow(dictationId)
        fail(err instanceof Error ? err.message : 'Microphone unavailable')
      }
    })()
  }, [cancel, cancelRow, closeAudio, sync, fail, flushChunk, releaseWakeLock])

  // Hard cap on hold length, armed once recording is actually live.
  useEffect(() => {
    if (status !== 'recording') return
    const t = setTimeout(() => stop(), MAX_HOLD_MS)
    return () => clearTimeout(t)
  }, [status, stop])

  // ── Result: the desktop's verdict on the row we're waiting for ────────────
  const result = useQuery(
    api.remoteDictation.dictationStatus,
    watchId ? {  dictationId: watchId } : 'skip',
  ) as { status: string; finalText: string; error: string } | null | undefined

  // The Convex subscription behind `result` is exactly the "subscribe for
  // updates from an external system" case the set-state-in-effect rule exempts;
  // useQuery just surfaces it as a value, which the rule can't see. The state
  // has to be stored rather than derived because the row is pruned a few minutes
  // later, and a deriving render would then fall back to 'processing'.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!watchId || !result) return
    if (result.status === 'done') {
      processingIdRef.current = null
      setWatchId(null)
      if (result.finalText.trim()) {
        onFinalTextRef.current?.(result.finalText.trim())
        setStatus('idle')
        setError(null)
      } else {
        // Transcription succeeded but heard nothing worth typing.
        fail('No speech detected.')
      }
    } else if (result.status === 'error') {
      processingIdRef.current = null
      fail(result.error || 'Transcription failed.')
    } else if (result.status === 'cancelled') {
      processingIdRef.current = null
      setWatchId(null)
      setStatus('idle')
    }
  }, [fail, result, watchId])
  /* eslint-enable react-hooks/set-state-in-effect */

  // The desktop may be asleep or the bridge down; don't spin forever.
  useEffect(() => {
    if (!watchId) return
    const t = setTimeout(() => {
      fail('No response from the desktop. Is Orchestra running?')
    }, RESULT_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [fail, watchId])

  // ── Interruptions ─────────────────────────────────────────────────────────
  // Backgrounding suspends the AudioContext on iOS, so anything captured past
  // this point is silence. Drop the utterance rather than submit a truncated one.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (acceptingChunksRef.current) cancel()
        return
      }
      // The OS drops the wake lock on every visibility change; re-acquire it or
      // a long utterance loses screen-lock protection halfway through.
      if (!acceptingChunksRef.current || wakeLockRef.current) return
      void navigator.wakeLock
        ?.request('screen')
        .then((lock) => {
          if (acceptingChunksRef.current) wakeLockRef.current = lock
          else void lock.release().catch(() => undefined)
        })
        .catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [cancel])

  // Unmount mid-utterance: release the mic *and* the server-side row.
  useEffect(
    () => () => {
      const id = activeIdRef.current
      generationRef.current += 1
      activeIdRef.current = null
      closeAudio()
      cancelRow(id)
      if (processingIdRef.current && processingIdRef.current !== id) cancelRow(processingIdRef.current)
      processingIdRef.current = null
    },
    [cancelRow, closeAudio],
  )

  // RMS of the newest waveform block, scaled so ordinary speech lands mid-range
  // rather than hugging the floor (raw RMS of a voice peaks around 0.1-0.2).
  const getLevel = useCallback(() => {
    const analyser = analyserRef.current
    const buf = meterBufRef.current
    if (!analyser || !buf) return 0
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128
      sum += v * v
    }
    return Math.min(1, Math.sqrt(sum / buf.length) * 4)
  }, [])

  return {
    status,
    isDictating: status === 'starting' || status === 'recording',
    isProcessing: status === 'processing',
    error,
    start,
    stop,
    cancel,
    getLevel,
  }
}
