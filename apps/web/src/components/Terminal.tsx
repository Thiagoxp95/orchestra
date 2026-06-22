'use client'
import { useEffect, useRef, useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { nextChunks, type Chunk } from '../lib/chunk-buffer'
import '@xterm/xterm/css/xterm.css'

const CONTROLS: { label: string; bytes: string }[] = [
  { label: '⏎', bytes: '\r' },
  { label: 'Esc', bytes: '\x1b' },
  { label: 'Ctrl-C', bytes: '\x03' },
  { label: '↑', bytes: '\x1b[A' },
  { label: '↓', bytes: '\x1b[B' },
]

export function TerminalPane({ token, sessionId }: { token: string; sessionId: string }) {
  const convex = useConvex()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [afterSeq, setAfterSeq] = useState(-1)

  const send = (kind: string, payload: unknown) =>
    void convex.mutation(anyApi.remote.sendCommand, { token, sessionId, kind, payload })

  // Mount xterm + attach lifecycle.
  useEffect(() => {
    const term = new Terminal({ convertEol: false, fontSize: 13, cursorBlink: true })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    fit.fit()
    termRef.current = term
    setAfterSeq(-1)

    send('attach', {})
    void convex.mutation(anyApi.remote.sendCommand, {
      token, sessionId, kind: 'resize', payload: { cols: term.cols, rows: term.rows },
    })

    const onData = term.onData((data) => send('write', { data }))
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
      <div style={{ display: 'flex', gap: 6, padding: 6, borderTop: '1px solid #333' }}>
        {CONTROLS.map((c) => (
          <button key={c.label} onClick={() => send('write', { data: c.bytes })}
            style={{ padding: '8px 12px' }}>{c.label}</button>
        ))}
      </div>
    </div>
  )
}
