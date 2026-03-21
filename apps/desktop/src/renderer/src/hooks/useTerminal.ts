import { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalLaunchProfile } from '../../../shared/types'
import { useAppStore } from '../store/app-store'
import { textColor } from '../utils/color'

const api = window.electronAPI

// xterm.js auto-responds to device attribute queries (DA1/DA2/DA3) from
// applications.  These responses travel renderer→PTY where the shell's line
// discipline may echo them before the application enters raw mode, producing
// visible garbage like "^[[?1;2c".  Strip them from onData before relaying.
const TERM_RESPONSE_RE = /\x1b\[[\?>][\d;]*[cRn]|\x1b\[[IO]|\x1b\](?:10|11|12);[^\x07\x1b]*(?:\x07|\x1b\\)/g

function stripTermResponses(data: string): string {
  return data.replace(TERM_RESPONSE_RE, '')
}

const MAX_RETRIES = 3
const RETRY_DELAYS = [500, 1500, 3000] // ms — escalating backoff

function shouldAutoScrollAgentSession(sessionId: string): boolean {
  const status = useAppStore.getState().sessions[sessionId]?.processStatus
  return status === 'claude' || status === 'codex'
}

async function createTerminalWithRetry(
  sessionId: string,
  opts: { cwd: string; cols: number; rows: number; initialCommand?: string; launchProfile?: TerminalLaunchProfile },
  term: Terminal,
  abortSignal: AbortSignal
): Promise<{ restoredSnapshot?: boolean } | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (abortSignal.aborted) return null

    const result = await api.createTerminal(sessionId, opts)
    if (result?.success) return { restoredSnapshot: result.restoredSnapshot === true }

    const isLastAttempt = attempt === MAX_RETRIES - 1
    if (isLastAttempt) {
      const errorMsg = result?.error || 'Unknown error'
      term.write(`\r\n\x1b[31m[orchestra] Failed to start terminal after ${MAX_RETRIES} attempts: ${errorMsg}\x1b[0m\r\n`)
      term.write(`\x1b[33m[orchestra] Press any key to retry...\x1b[0m\r\n`)

      // Let the user trigger a manual retry by pressing any key
      const retryDisposable = term.onData(() => {
        retryDisposable.dispose()
        term.write(`\r\n\x1b[36m[orchestra] Retrying...\x1b[0m\r\n`)
        createTerminalWithRetry(sessionId, opts, term, abortSignal)
      })
      return null
    }

    // Wait before retrying
    const delay = RETRY_DELAYS[attempt]
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay)
      // Cancel the wait if the component unmounts
      const onAbort = () => { clearTimeout(timer); resolve() }
      abortSignal.addEventListener('abort', onAbort, { once: true })
    })
  }

  return null
}

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

    const abortController = new AbortController()

    const term = new Terminal({
      cursorBlink: true,
      cursorInactiveStyle: 'block',
      fontSize: 14,
      fontFamily: '"JetBrainsMono Nerd Font Mono", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: termBg || '#1a1a2e',
        foreground: textColor(termBg || '#1a1a2e'),
        cursor: textColor(termBg || '#1a1a2e'),
        cursorAccent: termBg || '#1a1a2e'
      }
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    term.open(containerRef.current)

    fitAddon.fit()

    // Intercept macOS editing shortcuts that xterm.js ignores by default
    // (xterm passes Cmd+key and Option+key through to the browser)
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true

      // Cmd+Backspace → delete to beginning of line (Ctrl+U)
      if (e.metaKey && !e.altKey && !e.ctrlKey && e.key === 'Backspace') {
        e.preventDefault()
        api.writeTerminal(sessionId!, '\x15')
        return false
      }
      // Option+Backspace → delete word backward (ESC + DEL)
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.key === 'Backspace') {
        e.preventDefault()
        api.writeTerminal(sessionId!, '\x1b\x7f')
        return false
      }
      // Cmd+Delete (forward) → delete to end of line (Ctrl+K)
      if (e.metaKey && !e.altKey && !e.ctrlKey && e.key === 'Delete') {
        e.preventDefault()
        api.writeTerminal(sessionId!, '\x0b')
        return false
      }
      // Option+Delete (forward) → delete word forward (ESC + d)
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.key === 'Delete') {
        e.preventDefault()
        api.writeTerminal(sessionId!, '\x1bd')
        return false
      }

      return true
    })

    // Send user input to PTY via IPC
    term.onData((raw) => {
      const data = stripTermResponses(raw)
      if (!data) return
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
    let snapshotApplied = false
    let awaitingSnapshot = false
    let pendingSnapshot: any | null = null
    const pendingData: string[] = []

    const writeToTerminal = (data: string) => {
      term.write(data, () => {
        if (shouldAutoScrollAgentSession(sessionId)) {
          term.scrollToBottom()
        }
      })
    }

    const applySnapshot = (snapshot: any) => {
      term.reset()
      if (snapshot.rehydrateSequences) {
        writeToTerminal(snapshot.rehydrateSequences)
      }
      if (snapshot.snapshotAnsi) {
        writeToTerminal(snapshot.snapshotAnsi)
      }
      snapshotApplied = true
      awaitingSnapshot = false
      if (pendingData.length > 0) {
        for (const chunk of pendingData.splice(0)) {
          writeToTerminal(chunk)
        }
      }
    }

    const flushLiveDataIfReady = () => {
      if (!snapshotApplied || pendingData.length === 0) return
      for (const chunk of pendingData.splice(0)) {
        writeToTerminal(chunk)
      }
    }

    const removeDataListener = api.onTerminalData((sid: string, data: string) => {
      if (sid !== sessionId) return
      if (!snapshotApplied) {
        pendingData.push(data)
        return
      }
      writeToTerminal(data)
    })

    const removeSnapshotListener = api.onTerminalSnapshot((sid: string, snapshot: any) => {
      if (sid !== sessionId || !snapshot) return
      pendingSnapshot = snapshot
      if (awaitingSnapshot) {
        applySnapshot(snapshot)
        pendingSnapshot = null
      }
    })

    void createTerminalWithRetry(
      sessionId,
      { cwd, cols: term.cols, rows: term.rows, initialCommand, launchProfile },
      term,
      abortController.signal
    ).then((result) => {
      if (abortController.signal.aborted || !result) return

      if (result.restoredSnapshot) {
        awaitingSnapshot = true
        if (pendingSnapshot) {
          applySnapshot(pendingSnapshot)
          pendingSnapshot = null
        }
        return
      }

      snapshotApplied = true
      flushLiveDataIfReady()
    })

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
      abortController.abort()
      removeDataListener()
      removeSnapshotListener()
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
        cursor: fg,
        cursorAccent: termBg
      }
    }
  }, [termBg])

  return termRef
}
