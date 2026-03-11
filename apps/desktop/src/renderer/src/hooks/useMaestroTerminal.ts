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

    term.open(containerRef.current)

    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // WebGL not available, fall back to canvas renderer
    }

    // Send user input to PTY — only when this pane is focused
    term.onData((data) => {
      const { maestroFocusedSessionId } = useAppStore.getState()
      if (maestroFocusedSessionId !== sessionId) return
      api.writeTerminal(sessionId, data)
      // Clear "needs input" indicator as soon as the user presses Enter
      if (data.includes('\r') || data.includes('\n')) {
        const { sessionNeedsUserInput, clearSessionNeedsUserInput } = useAppStore.getState()
        if (sessionNeedsUserInput[sessionId]) {
          clearSessionNeedsUserInput(sessionId)
        }
      }
    })

    // Defer snapshot loading until after the first ResizeObserver callback,
    // which fires once CSS grid layout has computed the container's real size.
    // Without this, fitAddon.fit() runs before the container has dimensions,
    // resulting in ~5 columns and mangled text wrapping.
    let snapshotLoaded = false
    let removeDataListener: (() => void) | null = null

    const loadSnapshot = () => {
      if (snapshotLoaded) return
      // Wait until the container has real dimensions (grid layout computed)
      const el = containerRef.current
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return
      snapshotLoaded = true

      api.requestTerminalSnapshot(sessionId).then((snapshot) => {
        if (snapshot) {
          if (snapshot.rehydrateSequences) {
            term.write(snapshot.rehydrateSequences)
          }
          if (snapshot.snapshotAnsi) {
            term.write(snapshot.snapshotAnsi)
          }
        }

        // Now register the live data listener — any output from this point
        // forward is new and won't overlap with the snapshot.
        removeDataListener = api.onTerminalData((sid: string, data: string) => {
          if (sid === sessionId) {
            term.write(data)
          }
        })
      })
    }

    // Resize locally only — do NOT call api.resizeTerminal.
    // The first callback triggers fit + snapshot loading after layout is ready.
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      loadSnapshot()
    })
    resizeObserver.observe(containerRef.current)

    termRef.current = term
    fitAddonRef.current = fitAddon

    return () => {
      removeDataListener?.()
      resizeObserver.disconnect()
      term.dispose()
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
