import { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { useAppStore } from '../store/app-store'

const api = window.electronAPI

export function useMaestroTerminal(
  sessionId: string | null,
  containerRef: React.RefObject<HTMLDivElement | null>,
  termBg?: string,
  fontSize?: number
) {
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!sessionId || !containerRef.current) return

    const container = containerRef.current
    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSize ?? 14,
      fontFamily: '"JetBrainsMono Nerd Font Mono", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: termBg || '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0'
      }
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    // CRITICAL: Do NOT call term.open() until the container has real pixel
    // dimensions from CSS grid layout. Opening xterm at 0x0 corrupts its
    // internal font metrics, making all subsequent fitAddon.fit() calls
    // produce ~5 columns regardless of actual container size.
    let opened = false
    let removeDataListener: (() => void) | null = null

    const initTerminal = () => {
      if (opened) return
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      opened = true

      term.open(container)

      try {
        term.loadAddon(new WebglAddon())
      } catch {
        // WebGL not available, fall back to canvas renderer
      }

      fitAddon.fit()

      // Send user input to PTY — only when this pane is focused
      term.onData((data) => {
        const { maestroFocusedSessionId } = useAppStore.getState()
        if (maestroFocusedSessionId !== sessionId) return
        api.writeTerminal(sessionId, data)
        if (data.includes('\r') || data.includes('\n')) {
          const { sessionNeedsUserInput, clearSessionNeedsUserInput } = useAppStore.getState()
          if (sessionNeedsUserInput[sessionId]) {
            clearSessionNeedsUserInput(sessionId)
          }
        }
      })

      // Request initial snapshot, THEN register live data listener to avoid
      // a race where live output overlaps with the snapshot content.
      api.requestTerminalSnapshot(sessionId).then((snapshot) => {
        if (snapshot) {
          if (snapshot.rehydrateSequences) {
            term.write(snapshot.rehydrateSequences)
          }
          if (snapshot.snapshotAnsi) {
            term.write(snapshot.snapshotAnsi)
          }
        }

        removeDataListener = api.onTerminalData((sid: string, data: string) => {
          if (sid === sessionId) {
            term.write(data)
          }
        })
      })

      termRef.current = term
      fitAddonRef.current = fitAddon
    }

    // ResizeObserver fires when the container first gets real dimensions
    // from CSS grid layout, and on every subsequent resize.
    const resizeObserver = new ResizeObserver(() => {
      if (!opened) {
        initTerminal()
      } else {
        fitAddon.fit()
      }
    })
    resizeObserver.observe(container)

    return () => {
      removeDataListener?.()
      resizeObserver.disconnect()
      if (opened) term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId])

  // Update xterm background when workspace color changes
  useEffect(() => {
    if (termRef.current && termBg) {
      termRef.current.options.theme = {
        ...termRef.current.options.theme,
        background: termBg
      }
    }
  }, [termBg])

  // Update font size when grid layout changes
  useEffect(() => {
    if (termRef.current && fontSize) {
      termRef.current.options.fontSize = fontSize
      fitAddonRef.current?.fit()
    }
  }, [fontSize])

  return termRef
}
