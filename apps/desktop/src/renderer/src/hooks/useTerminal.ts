import { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { useAppStore } from '../store/app-store'

const api = window.electronAPI

const TITLE_IDLE_TIMEOUT = 2000

export function useTerminal(
  sessionId: string | null,
  cwd: string,
  containerRef: React.RefObject<HTMLDivElement | null>,
  termBg?: string,
  initialCommand?: string
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

    fitAddon.fit()

    // Create PTY with the correct terminal size
    api.createTerminal(sessionId, { cwd, cols: term.cols, rows: term.rows, initialCommand })

    // Send user input to PTY via IPC
    term.onData((data) => {
      api.writeTerminal(sessionId, data)
    })

    // Receive PTY output
    const removeDataListener = api.onTerminalData((sid: string, data: string) => {
      if (sid === sessionId) {
        term.write(data)
      }
    })

    // Listen for snapshot on reattach (daemon restore)
    const removeSnapshotListener = api.onTerminalSnapshot((sid: string, snapshot: any) => {
      if (sid === sessionId && snapshot) {
        term.reset()
        if (snapshot.rehydrateSequences) {
          term.write(snapshot.rehydrateSequences)
        }
        if (snapshot.snapshotAnsi) {
          term.write(snapshot.snapshotAnsi)
        }
      }
    })

    // Detect rapid title changes (e.g. Claude Code's spinner) → shimmer
    const setTitleChanging = useAppStore.getState().setTitleChanging
    let titleTimer: ReturnType<typeof setTimeout> | null = null
    const titleDisposable = term.onTitleChange(() => {
      setTitleChanging(sessionId, true)
      if (titleTimer) clearTimeout(titleTimer)
      titleTimer = setTimeout(() => {
        setTitleChanging(sessionId, false)
      }, TITLE_IDLE_TIMEOUT)
    })

    // Resize PTY when terminal container resizes
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      api.resizeTerminal(sessionId, term.cols, term.rows)
    })
    resizeObserver.observe(containerRef.current)

    termRef.current = term
    fitAddonRef.current = fitAddon

    return () => {
      titleDisposable.dispose()
      if (titleTimer) clearTimeout(titleTimer)
      setTitleChanging(sessionId, false)
      removeSnapshotListener()
      removeDataListener()
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

  return termRef
}
