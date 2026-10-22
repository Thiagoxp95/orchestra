'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { floatTo16BitPCM, StreamResampler, TARGET_SAMPLE_RATE } from '@/lib/dictation'

/**
 * Hold-to-talk: the mic streams 16 kHz PCM16 to the desktop over WS
 * /api/dictate while the button is held, and the desktop answers the release
 * with cleaned-up text (Qwen3-ASR, then an LLM; see desktop dictation/). The
 * socket opens with the terminal view so the desktop warms its model before
 * the first press.
 */
export type DictationStatus = 'idle' | 'starting' | 'listening' | 'working' | 'error'

/** Shorter than this is a tap, not a dictation. */
const MIN_HOLD_MS = 350
const REPLY_TIMEOUT_MS = 45_000

interface Press {
  id: number
  at: number
  released: boolean
  teardown: (() => Promise<void>) | null
}

function dictateUrl(): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/dictate`
}

export function useDictation(onText: (text: string) => boolean) {
  const [status, setStatus] = useState<DictationStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pressRef = useRef<Press | null>(null)
  const nextId = useRef(1)
  const replies = useRef(new Map<number, (reply: { text?: string; message?: string }) => void>())
  const onTextRef = useRef(onText)
  onTextRef.current = onText
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fail = useCallback((message: string) => {
    setError(message)
    setStatus('error')
    if (errorTimer.current) clearTimeout(errorTimer.current)
    errorTimer.current = setTimeout(() => {
      setError(null)
      setStatus((s) => (s === 'error' ? 'idle' : s))
    }, 3000)
  }, [])

  useEffect(() => {
    let closed = false
    let retry: ReturnType<typeof setTimeout> | null = null
    let delay = 1000
    const connect = () => {
      const ws = new WebSocket(dictateUrl())
      wsRef.current = ws
      ws.onopen = () => { delay = 1000 }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as { id: number; text?: string; message?: string }
          replies.current.get(msg.id)?.(msg)
        } catch {
          // Not ours.
        }
      }
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null
        for (const settle of replies.current.values()) settle({ message: 'Lost the connection to your Mac' })
        if (closed) return
        retry = setTimeout(connect, delay)
        delay = Math.min(delay * 2, 15_000)
      }
    }
    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      wsRef.current?.close()
      void pressRef.current?.teardown?.()
      if (errorTimer.current) clearTimeout(errorTimer.current)
    }
  }, [])

  const send = (message: object | ArrayBuffer) => {
    const ws = wsRef.current
    if (ws?.readyState !== WebSocket.OPEN) return false
    ws.send(message instanceof ArrayBuffer ? message : JSON.stringify(message))
    return true
  }

  /** Release: the tail flushed, then the text typed in. */
  const finish = useCallback(async (press: Press) => {
    await press.teardown?.()
    press.teardown = null
    if (performance.now() - press.at < MIN_HOLD_MS) {
      send({ t: 'cancel', id: press.id })
      pressRef.current = null
      setStatus('idle')
      return
    }
    setStatus('working')
    const reply = await new Promise<{ text?: string; message?: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ message: 'Your Mac took too long to answer' }), REPLY_TIMEOUT_MS)
      replies.current.set(press.id, (r) => {
        clearTimeout(timer)
        replies.current.delete(press.id)
        resolve(r)
      })
      if (!send({ t: 'end', id: press.id })) replies.current.get(press.id)?.({ message: 'Not connected to your Mac' })
    })
    if (pressRef.current === press) pressRef.current = null
    if (reply.message !== undefined && reply.text === undefined) return fail(reply.message)
    const text = reply.text?.trim() ?? ''
    if (!text) return fail('No speech heard')
    if (!onTextRef.current(text)) return fail('Take control of this terminal first')
    setStatus('idle')
  }, [fail])

  const start = useCallback(async () => {
    if (pressRef.current) return
    const press: Press = { id: nextId.current++, at: performance.now(), released: false, teardown: null }
    pressRef.current = press
    if (!send({ t: 'start', id: press.id })) {
      pressRef.current = null
      return fail('Not connected to your Mac')
    }
    setStatus('starting')
    navigator.vibrate?.(10)
    let stream = null as MediaStream | null
    let ctx = null as AudioContext | null
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      try {
        ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
      } catch {
        ctx = new AudioContext()
      }
      await ctx.audioWorklet.addModule('/dictation-worklet.js')
    } catch {
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
      send({ t: 'cancel', id: press.id })
      pressRef.current = null
      return fail('The microphone would not open')
    }
    const resampler = new StreamResampler(ctx.sampleRate)
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'pcm-capture')
    let flushed: (() => void) | null = null
    node.port.onmessage = (event) => {
      if (event.data === 'flushed') return flushed?.()
      const pcm = floatTo16BitPCM(resampler.process(event.data as Float32Array))
      if (pcm.length) send(pcm.buffer as ArrayBuffer)
    }
    source.connect(node)
    node.connect(ctx.destination) // a worklet nothing pulls never runs; it writes no output
    const audio = ctx
    const mic = stream
    press.teardown = async () => {
      await new Promise<void>((resolve) => {
        flushed = resolve
        node.port.postMessage('flush')
        setTimeout(resolve, 300)
      })
      source.disconnect()
      node.disconnect()
      mic.getTracks().forEach((t) => t.stop())
      await audio.close().catch(() => {})
    }
    if (press.released) return void finish(press)
    setStatus('listening')
  }, [fail, finish])

  const stop = useCallback(() => {
    const press = pressRef.current
    if (!press || press.released) return
    press.released = true
    // Still opening the mic: start() finishes the press once it has.
    if (press.teardown) void finish(press)
  }, [finish])

  // A press abandoned by switching away would leave the mic open.
  useEffect(() => {
    const onHide = () => { if (document.hidden) stop() }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [stop])

  return { status, error, start, stop }
}
