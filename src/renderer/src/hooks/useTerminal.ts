import { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'

const api = window.electronAPI

export function useTerminal(
  sessionId: string | null,
  containerRef: React.RefObject<HTMLDivElement | null>,
  scrollback?: string
) {
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!sessionId || !containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0'
      }
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    term.open(containerRef.current)

    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // WebGL not available, fall back to canvas renderer
    }

    fitAddon.fit()

    // Write saved scrollback if restoring a session
    if (scrollback) {
      term.write(scrollback)
    }

    // Send user input to PTY via IPC
    term.onData((data) => {
      api.writeTerminal(sessionId, data)
    })

    // Receive PTY output via IPC
    const onData = (sid: string, data: string) => {
      if (sid === sessionId) {
        term.write(data)
      }
    }
    api.onTerminalData(onData)

    // Resize PTY when terminal container resizes
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      api.resizeTerminal(sessionId, term.cols, term.rows)
    })
    resizeObserver.observe(containerRef.current)

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Send initial resize to PTY
    api.resizeTerminal(sessionId, term.cols, term.rows)

    return () => {
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId])

  return termRef
}
