'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { nextChunks, type Chunk } from '../lib/chunk-buffer'
import {
  anyModifier,
  charBytes,
  NO_MODS,
  specialKeyBytes,
  type Modifiers,
} from '../lib/keyboard'
import { AgentKeyBar } from './AgentKeyBar'
import '@xterm/xterm/css/xterm.css'

export function TerminalPane({ token, sessionId }: { token: string; sessionId: string }) {
  const convex = useConvex()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [afterSeq, setAfterSeq] = useState(-1)

  // Sticky modifiers from the accessory key bar. A ref mirrors state so the
  // xterm onData handler (registered once per session) reads current values.
  const [mods, setMods] = useState<Modifiers>(NO_MODS)
  const modsRef = useRef<Modifiers>(NO_MODS)
  modsRef.current = mods

  const write = useCallback(
    (data: string) => {
      if (data) void convex.mutation(anyApi.remote.sendCommand, { token, sessionId, kind: 'write', payload: { data } })
    },
    [convex, token, sessionId],
  )

  const onToggleMod = useCallback((name: keyof Modifiers) => {
    setMods((m) => ({ ...m, [name]: !m[name] }))
  }, [])

  const onSpecial = useCallback(
    (key: string) => {
      write(specialKeyBytes(key))
      setMods(NO_MODS)
    },
    [write],
  )

  // Mount xterm + attach lifecycle.
  useEffect(() => {
    const term = new Terminal({ convertEol: false, fontSize: 13, cursorBlink: true })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    fit.fit()
    termRef.current = term
    setAfterSeq(-1)

    const send = (kind: string, payload: unknown) =>
      void convex.mutation(anyApi.remote.sendCommand, { token, sessionId, kind, payload })

    send('attach', {})
    send('resize', { cols: term.cols, rows: term.rows })

    const onData = term.onData((data) => {
      const m = modsRef.current
      // Apply armed modifiers to a single printable char from the device keyboard.
      if (anyModifier(m) && data.length === 1) {
        send('write', { data: charBytes(data, m) })
        setMods(NO_MODS)
      } else {
        send('write', { data })
      }
    })
    const onResize = () => {
      fit.fit()
      send('resize', { cols: term.cols, rows: term.rows })
    }
    window.addEventListener('resize', onResize)

    return () => {
      send('detach', {})
      onData.dispose()
      window.removeEventListener('resize', onResize)
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Stream chunks → xterm.
  const chunks = useQuery(anyApi.remote.getChunks, { token, sessionId, afterSeq }) as Chunk[] | undefined
  useEffect(() => {
    if (!chunks || chunks.length === 0 || !termRef.current) return
    const { data, afterSeq: next } = nextChunks(chunks, afterSeq)
    if (data) termRef.current.write(data)
    if (next !== afterSeq) setAfterSeq(next)
  }, [chunks, afterSeq])

  return (
    <div className="flex h-full flex-col">
      <div ref={hostRef} className="min-h-0 flex-1 bg-black p-1" />
      <AgentKeyBar mods={mods} onToggleMod={onToggleMod} onSpecial={onSpecial} />
    </div>
  )
}
