'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvex } from 'convex/react'
import { anyApi } from 'convex/server'
import {
  downsampleTo16k,
  floatTo16BitPCM,
  int16ToBase64,
  samplesPerChunk,
  TARGET_SAMPLE_RATE,
} from '../lib/dictation'

export interface DictationControls {
  isDictating: boolean
  error: string | null
  start: () => void
  stop: () => void
}

// Hard cap so a stuck button on the street can't record forever.
const MAX_HOLD_MS = 60_000

export function useDictation(token: string, sessionId: string): DictationControls {
  const convex = useConvex()
  const [isDictating, setIsDictating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const nodeRef = useRef<AudioWorkletNode | null>(null)
  const accRef = useRef<Float32Array[]>([])
  const accLenRef = useRef(0)
  const seqRef = useRef(0)
  const idRef = useRef<string | null>(null)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The transcript is typed straight into the agent PTY on the desktop when the
  // utterance finalizes — there is no live preview to subscribe to here.

  const flushChunk = useCallback(
    (rate: number) => {
      const id = idRef.current
      if (!id) return
      const total = accLenRef.current
      const merged = new Float32Array(total)
      let off = 0
      for (const a of accRef.current) {
        merged.set(a, off)
        off += a.length
      }
      accRef.current = []
      accLenRef.current = 0
      const pcm = floatTo16BitPCM(downsampleTo16k(merged, rate))
      const b64 = int16ToBase64(pcm)
      void convex.mutation(anyApi.remoteDictation.appendDictationChunk, {
        token,
        dictationId: id,
        seq: seqRef.current++,
        pcm: b64,
      })
    },
    [convex, token],
  )

  const teardown = useCallback(() => {
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current)
    maxTimerRef.current = null
    nodeRef.current?.disconnect()
    nodeRef.current = null
    void ctxRef.current?.close()
    ctxRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    accRef.current = []
    accLenRef.current = 0
  }, [])

  const stop = useCallback(() => {
    if (!isDictating) return
    setIsDictating(false)
    const id = idRef.current
    const rate = ctxRef.current?.sampleRate ?? TARGET_SAMPLE_RATE
    if (accLenRef.current > 0) flushChunk(rate)
    teardown()
    if (id) void convex.mutation(anyApi.remoteDictation.endDictation, { token, dictationId: id })
  }, [convex, flushChunk, isDictating, teardown, token])

  const start = useCallback(() => {
    if (isDictating) return
    setError(null)
    const id = crypto.randomUUID()
    idRef.current = id
    seqRef.current = 0
    setIsDictating(true)
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream
        const ctx = new AudioContext()
        ctxRef.current = ctx
        await ctx.audioWorklet.addModule('/dictation-worklet.js')
        const source = ctx.createMediaStreamSource(stream)
        const node = new AudioWorkletNode(ctx, 'pcm-capture')
        nodeRef.current = node
        const chunkSamples = samplesPerChunk(ctx.sampleRate)
        node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
          accRef.current.push(ev.data)
          accLenRef.current += ev.data.length
          if (accLenRef.current >= chunkSamples) flushChunk(ctx.sampleRate)
        }
        source.connect(node)
        // Worklets only pull when connected to a destination; a zero-gain sink
        // keeps the graph running without echoing the mic to the speakers.
        const sink = ctx.createGain()
        sink.gain.value = 0
        node.connect(sink).connect(ctx.destination)
        await convex.mutation(anyApi.remoteDictation.startDictation, { token, dictationId: id, sessionId })
        maxTimerRef.current = setTimeout(stop, MAX_HOLD_MS)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'microphone unavailable')
        setIsDictating(false)
        teardown()
        if (idRef.current) {
          void convex.mutation(anyApi.remoteDictation.cancelDictation, { token, dictationId: idRef.current })
        }
      }
    })()
  }, [convex, flushChunk, isDictating, sessionId, stop, teardown, token])

  // Stop cleanly if the component unmounts mid-utterance.
  useEffect(() => () => { teardown() }, [teardown])

  return { isDictating, error, start, stop }
}
