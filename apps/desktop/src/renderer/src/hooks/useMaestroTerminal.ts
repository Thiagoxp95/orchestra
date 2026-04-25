import { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useAppStore } from '../store/app-store'
import { updateAgentInputBuffer } from '../utils/agent-input'
import { splitTerminalResponses } from '../utils/terminal-responses'

const api = window.electronAPI

type XtermWithCore = Terminal & {
  _core?: {
    _charSizeService?: {
      measure?: () => void
    }
  }
}

export function useMaestroTerminal(
  sessionId: string | null,
  containerRef: React.RefObject<HTMLDivElement | null>,
  termBg?: string,
  fontSize?: number
) {
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const lastSyncedSizeRef = useRef<{ cols: number; rows: number } | null>(null)

  const remeasureAndFit = () => {
    const term = termRef.current as XtermWithCore | null
    const fitAddon = fitAddonRef.current
    if (!term || !fitAddon) return

    // Maestro mounts fresh terminals into a newly created grid. Re-measuring
    // before fit avoids getting stuck with wildly inflated cell widths.
    term._core?._charSizeService?.measure?.()
    fitAddon.fit()
  }

  const syncPtySize = (force = false) => {
    const term = termRef.current
    if (!term || !sessionId) return null

    const nextSize = { cols: term.cols, rows: term.rows }
    if (nextSize.cols <= 0 || nextSize.rows <= 0) return null

    const lastSize = lastSyncedSizeRef.current
    if (!force && lastSize && lastSize.cols === nextSize.cols && lastSize.rows === nextSize.rows) {
      return nextSize
    }

    lastSyncedSizeRef.current = nextSize
    api.resizeTerminal(sessionId, nextSize.cols, nextSize.rows)
    return nextSize
  }

  useEffect(() => {
    if (!sessionId || !containerRef.current) return

    const container = containerRef.current
    const term = new Terminal({
      cursorBlink: true,
      cursorInactiveStyle: 'block',
      fontSize: fontSize ?? 14,
      fontFamily: '"JetBrainsMono Nerd Font Mono", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: termBg || '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        cursorAccent: termBg || '#1a1a2e'
      }
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    // CRITICAL: Do NOT call term.open() until the container has real pixel
    // dimensions from CSS grid layout. Opening xterm at 0x0 corrupts its
    // internal font metrics, making all subsequent fitAddon.fit() calls
    // produce ~5 columns regardless of actual container size.
    let opened = false
    let disposed = false
    let removeDataListener: (() => void) | null = null
    let postOpenRaf1: number | null = null
    let postOpenRaf2: number | null = null
    let pendingAgentInput = ''

    const schedulePostOpenFit = () => {
      if (!opened || disposed) return

      postOpenRaf1 = window.requestAnimationFrame(() => {
        if (disposed || !opened) return
        remeasureAndFit()
        syncPtySize()

        postOpenRaf2 = window.requestAnimationFrame(() => {
          if (disposed || !opened) return
          remeasureAndFit()
          syncPtySize()
        })
      })
    }

    const initTerminal = () => {
      if (opened) return
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      opened = true

      term.open(container)
      termRef.current = term
      fitAddonRef.current = fitAddon

      remeasureAndFit()
      const initialSize = syncPtySize(true)
      schedulePostOpenFit()

      void container.ownerDocument.fonts?.ready.then(() => {
        if (disposed || !opened) return
        remeasureAndFit()
        syncPtySize()
      })

      // Intercept macOS editing shortcuts that xterm.js ignores by default
      // (xterm passes Cmd+key and Option+key through to the browser)
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== 'keydown') return true
        // Only handle when this pane is focused
        const { maestroFocusedSessionId } = useAppStore.getState()
        if (maestroFocusedSessionId !== sessionId) return true

        // Cmd+Left → beginning of line (Ctrl+A)
        if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowLeft') {
          e.preventDefault()
          api.writeTerminal(sessionId, '\x01')
          return false
        }
        // Cmd+Right → end of line (Ctrl+E)
        if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowRight') {
          e.preventDefault()
          api.writeTerminal(sessionId, '\x05')
          return false
        }

        // Cmd+Backspace → delete to beginning of line (Ctrl+U)
        if (e.metaKey && !e.altKey && !e.ctrlKey && e.key === 'Backspace') {
          e.preventDefault()
          api.writeTerminal(sessionId, '\x15')
          return false
        }
        // Option+Backspace → delete word backward (ESC + DEL)
        if (e.altKey && !e.metaKey && !e.ctrlKey && e.key === 'Backspace') {
          e.preventDefault()
          api.writeTerminal(sessionId, '\x1b\x7f')
          return false
        }
        // Cmd+Delete (forward) → delete to end of line (Ctrl+K)
        if (e.metaKey && !e.altKey && !e.ctrlKey && e.key === 'Delete') {
          e.preventDefault()
          api.writeTerminal(sessionId, '\x0b')
          return false
        }
        // Option+Delete (forward) → delete word forward (ESC + d)
        if (e.altKey && !e.metaKey && !e.ctrlKey && e.key === 'Delete') {
          e.preventDefault()
          api.writeTerminal(sessionId, '\x1bd')
          return false
        }

        return true
      })

      // Send user input to PTY — only when this pane is focused
      term.onData((raw) => {
        const { input: data, responses } = splitTerminalResponses(raw)
        const { maestroFocusedSessionId, sessions } = useAppStore.getState()
        if (maestroFocusedSessionId !== sessionId) return
        const status = sessions[sessionId]?.processStatus
        if (responses && (status === 'claude' || status === 'codex')) {
          api.writeTerminal(sessionId, responses, 'system')
        }
        if (!data) return
        api.writeTerminal(sessionId, data)
        const { startAgentRun } = useAppStore.getState()
        if (status === 'claude' || status === 'codex') {
          const update = updateAgentInputBuffer(pendingAgentInput, data)
          pendingAgentInput = update.nextBuffer
          if (update.submittedPrompt) {
            startAgentRun(sessionId)
          }
        }
        if (data.includes('\r') || data.includes('\n')) {
          const { sessionNeedsUserInput, clearSessionNeedsUserInput } = useAppStore.getState()
          if (sessionNeedsUserInput[sessionId]) {
            clearSessionNeedsUserInput(sessionId)
          }
        }
      })

      const writeToTerminal = (data: string) => {
        term.write(data)
      }

      // Request initial snapshot, THEN register live data listener to avoid
      // a race where live output overlaps with the snapshot content.
      api.requestTerminalSnapshot(sessionId, initialSize ?? undefined).then((snapshot) => {
        if (snapshot) {
          term.reset()
          if (snapshot.rehydrateSequences) {
            writeToTerminal(snapshot.rehydrateSequences)
          }
          if (snapshot.snapshotAnsi) {
            writeToTerminal(snapshot.snapshotAnsi)
          }
        }

        removeDataListener = api.onTerminalData((sid: string, data: string) => {
          if (sid === sessionId) {
            writeToTerminal(data)
          }
        })
      })
    }

    // ResizeObserver fires when the container first gets real dimensions
    // from CSS grid layout, and on every subsequent resize.
    const resizeObserver = new ResizeObserver(() => {
      if (!opened) {
        initTerminal()
      } else {
        remeasureAndFit()
        syncPtySize()
      }
    })
    resizeObserver.observe(container)

    return () => {
      disposed = true
      lastSyncedSizeRef.current = null
      removeDataListener?.()
      if (postOpenRaf1 !== null) window.cancelAnimationFrame(postOpenRaf1)
      if (postOpenRaf2 !== null) window.cancelAnimationFrame(postOpenRaf2)
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
        background: termBg,
        cursorAccent: termBg
      }
    }
  }, [termBg])

  // Update font size when grid layout changes
  useEffect(() => {
    if (termRef.current && fontSize) {
      termRef.current.options.fontSize = fontSize
      remeasureAndFit()
      syncPtySize()
    }
  }, [fontSize])

  // Snap the viewport to the bottom when an agent transitions from
  // working → idle. During the run we let xterm's native follow-the-bottom
  // behavior handle things, so the user can scroll back to read output
  // without being yanked down on every write.
  useEffect(() => {
    if (!sessionId) return
    let prevClaude = useAppStore.getState().claudeWorkState[sessionId]
    let prevCodex = useAppStore.getState().codexWorkState[sessionId]
    return useAppStore.subscribe((state) => {
      const nextClaude = state.claudeWorkState[sessionId]
      const nextCodex = state.codexWorkState[sessionId]
      const claudeFinished = prevClaude === 'working' && nextClaude === 'idle'
      const codexFinished = prevCodex === 'working' && nextCodex === 'idle'
      prevClaude = nextClaude
      prevCodex = nextCodex
      if (claudeFinished || codexFinished) {
        termRef.current?.scrollToBottom()
      }
    })
  }, [sessionId])

  return termRef
}
