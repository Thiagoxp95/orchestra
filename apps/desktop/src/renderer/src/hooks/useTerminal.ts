import { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import type { TerminalLaunchProfile } from '../../../shared/types'
import { useAppStore } from '../store/app-store'
import { textColor } from '../utils/color'

const api = window.electronAPI

export function useTerminal(
  sessionId: string | null,
  cwd: string,
  containerRef: React.RefObject<HTMLDivElement | null>,
  termBg?: string,
  initialCommand?: string,
  launchProfile?: TerminalLaunchProfile
) {
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!sessionId || !containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"JetBrainsMono Nerd Font Mono", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: termBg || '#1a1a2e',
        foreground: textColor(termBg || '#1a1a2e'),
        cursor: textColor(termBg || '#1a1a2e')
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

    // Send user input to PTY via IPC
    term.onData((data) => {
      api.writeTerminal(sessionId, data)
      // Clear "needs input" indicator as soon as the user presses Enter
      if (data.includes('\r') || data.includes('\n')) {
        const { sessionNeedsUserInput, clearSessionNeedsUserInput } = useAppStore.getState()
        if (sessionNeedsUserInput[sessionId]) {
          clearSessionNeedsUserInput(sessionId)
        }
      }
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

    // Register listeners before creating the PTY so the first prompt/output
    // is not lost during session startup.
    api.createTerminal(sessionId, { cwd, cols: term.cols, rows: term.rows, initialCommand, launchProfile })

    // Resize PTY when terminal container resizes
    const resizeObserver = new ResizeObserver(() => {
      const container = containerRef.current
      if (!container) return

      const { maestroMode } = useAppStore.getState()
      const isHidden = container.clientWidth === 0 || container.clientHeight === 0 || container.getClientRects().length === 0
      if (maestroMode || isHidden) return

      fitAddon.fit()
      api.resizeTerminal(sessionId, term.cols, term.rows)
    })
    resizeObserver.observe(containerRef.current)

    termRef.current = term
    fitAddonRef.current = fitAddon

    return () => {
      removeSnapshotListener()
      removeDataListener()
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId])

  // Update xterm theme when workspace color changes
  useEffect(() => {
    if (termRef.current && termBg) {
      const fg = textColor(termBg)
      termRef.current.options.theme = {
        ...termRef.current.options.theme,
        background: termBg,
        foreground: fg,
        cursor: fg
      }
    }
  }, [termBg])

  return termRef
}
