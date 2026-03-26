import { useRef, useEffect } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { textColor } from '../utils/color'

const api = window.electronAPI

/** Strip xterm.js auto-responses (DA1/DA2/DA3) before relaying to PTY. */
const TERM_RESPONSE_RE = /\x1b\[[\?>][\d;]*[cRn]|\x1b\[[IO]|\x1b\](?:10|11|12);[^\x07\x1b]*(?:\x07|\x1b\\)/g

function stripTermResponses(data: string): string {
  return data.replace(TERM_RESPONSE_RE, '')
}

function getParams(): {
  sessionId: string
  workspaceName: string
  workspaceColor: string
  sessionLabel: string
} {
  const params = new URLSearchParams(window.location.search)
  return {
    sessionId: params.get('sessionId') ?? '',
    workspaceName: params.get('workspaceName') ?? 'Workspace',
    workspaceColor: params.get('workspaceColor') ?? '#1a1a2e',
    sessionLabel: params.get('sessionLabel') ?? 'Terminal',
  }
}

export function PopupTerminal() {
  const { sessionId, workspaceName, workspaceColor, sessionLabel } = getParams()
  const containerRef = useRef<HTMLDivElement>(null)

  const termBg = workspaceColor
  const fg = textColor(termBg)

  useEffect(() => {
    if (!sessionId || !containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      cursorInactiveStyle: 'block',
      fontSize: 14,
      fontFamily: '"JetBrainsMono Nerd Font Mono", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: termBg,
        foreground: fg,
        cursor: fg,
        cursorAccent: termBg,
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    // Send user input to PTY — dismiss popup on Enter
    term.onData((raw) => {
      const data = stripTermResponses(raw)
      if (!data) return
      api.writeTerminal(sessionId, data)
      if (data.includes('\r') || data.includes('\n')) {
        // User submitted input — ask main process to dismiss us.
        // The main process hides the app first to avoid focus stealing.
        api.dismissInterruptionPopup(sessionId)
      }
    })

    // Receive PTY output
    let snapshotApplied = false
    const pendingData: string[] = []

    const removeDataListener = api.onTerminalData((sid: string, data: string) => {
      if (sid !== sessionId) return
      if (!snapshotApplied) {
        pendingData.push(data)
        return
      }
      term.write(data, () => term.scrollToBottom())
    })

    const applySnapshot = (snapshot: { rehydrateSequences?: string; snapshotAnsi?: string }) => {
      term.reset()
      if (snapshot.rehydrateSequences) term.write(snapshot.rehydrateSequences)
      if (snapshot.snapshotAnsi) term.write(snapshot.snapshotAnsi)
      snapshotApplied = true
      for (const chunk of pendingData.splice(0)) {
        term.write(chunk)
      }
      term.scrollToBottom()
    }

    const removeSnapshotListener = api.onTerminalSnapshot((sid: string, snapshot: any) => {
      if (sid !== sessionId || !snapshot) return
      applySnapshot(snapshot)
    })

    // Request a snapshot at the popup's own dimensions so content wraps correctly
    api.requestTerminalSnapshot(sessionId, { cols: term.cols, rows: term.rows }).then((snapshot) => {
      if (!snapshot) {
        snapshotApplied = true
        for (const chunk of pendingData.splice(0)) {
          term.write(chunk)
        }
        term.scrollToBottom()
        return
      }
      applySnapshot(snapshot)
    })

    // Auto-focus terminal
    term.focus()

    // Close on Escape — use the same dismiss IPC to avoid focus steal
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type === 'keydown' && e.key === 'Escape') {
        api.dismissInterruptionPopup(sessionId)
        return false
      }
      return true
    })

    // Fit xterm to container but do NOT resize the PTY — the main window
    // terminal owns the PTY dimensions and they would fight otherwise.
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      removeDataListener()
      removeSnapshotListener()
      resizeObserver.disconnect()
      term.dispose()
    }
  }, [sessionId])

  const handleClose = () => {
    api.dismissInterruptionPopup(sessionId)
  }

  if (!sessionId) {
    return <div style={{ color: '#fff', padding: 20 }}>Missing session ID</div>
  }

  return (
    <div
      className="flex flex-col h-screen w-screen overflow-hidden"
      style={{
        backgroundColor: termBg,
        borderRadius: 12,
        border: `1px solid ${fg}22`,
      }}
    >
      {/* Header — draggable */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 select-none"
        style={{
          WebkitAppRegion: 'drag' as any,
          borderBottom: `1px solid ${fg}15`,
        }}
      >
        {/* Color dot */}
        <div
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: workspaceColor, border: `1px solid ${fg}33` }}
        />
        {/* Workspace + session label */}
        <span className="text-xs font-medium truncate" style={{ color: fg + 'cc' }}>
          {workspaceName}
        </span>
        <span className="text-xs truncate" style={{ color: fg + '88' }}>
          {sessionLabel}
        </span>
        {/* Spacer */}
        <div className="flex-1" />
        {/* Close button */}
        <button
          onClick={handleClose}
          className="text-xs px-1.5 py-0.5 rounded hover:opacity-80 transition-opacity"
          style={{
            color: fg + '88',
            WebkitAppRegion: 'no-drag' as any,
          }}
        >
          ×
        </button>
      </div>

      {/* Terminal body */}
      <div ref={containerRef} className="flex-1 p-2 overflow-hidden" />
    </div>
  )
}
