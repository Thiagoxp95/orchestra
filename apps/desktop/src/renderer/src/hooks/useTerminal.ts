import { createTerminalWriteQueue } from './terminal-write-queue'
import { enableTerminalWebgl } from './terminal-webgl'
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { CreateTerminalResult, TerminalLaunchProfile } from '../../../shared/types'
import { useAppStore } from '../store/app-store'
import { textColor } from '../utils/color'
import { updateAgentInputBuffer } from '../utils/agent-input'
import { splitTerminalResponses } from '../utils/terminal-responses'
import { attachTerminalAutoFit, type AutoFitHandle } from './terminal-autofit'
import { isSaneGeometry, planPtyResize, type Geometry } from '../utils/terminal-geometry'

const api = window.electronAPI

const MAX_RETRIES = 3
const RETRY_DELAYS = [500, 1500, 3000] // ms — escalating backoff

// Agent TUIs (Claude Code, Codex, etc.) enable mouse-tracking modes for their
// UI. When such a process is killed instead of exiting cleanly, it never emits
// the matching disable sequence, so the mode stays armed at the shell prompt:
// xterm then reports every scroll/move as an SGR sequence (e.g. `\x1b[<35;…M`),
// whose `\x1b[` the shell swallows and whose tail ("35;31;18M") it inserts as
// stray text. Writing these disables to the local terminal clears that stale
// state; a freshly launched agent simply re-arms whatever it needs.
const MOUSE_TRACKING_RESET = '\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l'
const AGENT_PROCESS_STATUSES = new Set(['claude', 'codex', 'cursor'])

async function createTerminalWithRetry(
  sessionId: string,
  opts: { cwd: string; cols: number; rows: number; initialCommand?: string; launchProfile?: TerminalLaunchProfile },
  term: Terminal,
  abortSignal: AbortSignal,
  onRetry: () => void,
): Promise<CreateTerminalResult | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (abortSignal.aborted) return null

    const result = await api.createTerminal(sessionId, opts)
    if (result?.success) return result

    const isLastAttempt = attempt === MAX_RETRIES - 1
    if (isLastAttempt) {
      const errorMsg = result?.error || 'Unknown error'
      term.write(`\r\n\x1b[31m[orchestra] Failed to start terminal after ${MAX_RETRIES} attempts: ${errorMsg}\x1b[0m\r\n`)
      term.write(`\x1b[33m[orchestra] Press any key to retry...\x1b[0m\r\n`)

      // Let the user trigger a manual retry by pressing any key
      const retryDisposable = term.onData(() => {
        retryDisposable.dispose()
        term.write(`\r\n\x1b[36m[orchestra] Retrying...\x1b[0m\r\n`)
        if (!abortSignal.aborted) onRetry()
      })
      abortSignal.addEventListener('abort', () => retryDisposable.dispose(), { once: true })
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

/** Bound font/layout readiness so hidden background panes can still start. */
async function waitForTerminalLayout(signal: AbortSignal): Promise<void> {
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timeout); signal.removeEventListener('abort', done); resolve() }
    const timeout = setTimeout(done, 600)
    signal.addEventListener('abort', done, { once: true })
    const fonts = document.fonts
    void Promise.allSettled(fonts ? [fonts.load('14px "JetBrainsMono Nerd Font Mono"'), fonts.ready] : []).then(done)
  })
  if (signal.aborted) return
  await new Promise<void>(resolve => {
    let first = 0; let second = 0
    const done = () => { clearTimeout(timeout); cancelAnimationFrame(first); cancelAnimationFrame(second); signal.removeEventListener('abort', done); resolve() }
    const timeout = setTimeout(done, 100)
    signal.addEventListener('abort', done, { once: true })
    first = requestAnimationFrame(() => { second = requestAnimationFrame(done) })
  })
}

export function useTerminal(
  sessionId: string | null,
  cwd: string,
  containerRef: React.RefObject<HTMLDivElement | null>,
  termBg?: string,
  initialCommand?: string,
  launchProfile?: TerminalLaunchProfile,
  isActive = false,
) {
  const termRef = useRef<Terminal | null>(null)
  const attachRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    if (!sessionId || !containerRef.current) return

    const abortController = new AbortController()
    let pendingAgentInput = ''

    const term = new Terminal({
      cursorBlink: true,
      scrollback: 10000,
      smoothScrollDuration: 100,
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

    const output = createTerminalWriteQueue((text, done) => term.write(text, done))
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    // Wrap the terminal in a scaler so the desktop can flip between two modes over
    // the single shared PTY (see remote-bridge geometry ownership):
    //  - DRIVER (owner 'desktop', the default): host fills the container, the
    //    autofit controller fits the PTY to it, scale = 1. Behaves exactly as the
    //    pre-scaler code (term opened directly in a full-size element).
    //  - VIEWER (owner 'web'): a focused phone drives the PTY size, so we stop
    //    fitting, resize xterm to the phone's geometry, and uniformly scale the
    //    result to fit the desktop pane — the mirror image of what the web does
    //    when the desktop owns geometry.
    const container = containerRef.current
    container.style.position = 'relative'
    container.style.overflow = 'hidden'
    const scaleEl = document.createElement('div')
    const hostEl = document.createElement('div')
    scaleEl.appendChild(hostEl)
    container.appendChild(scaleEl)
    const setDriverStyles = () => {
      scaleEl.style.cssText = 'position:absolute;inset:0;transform:none;transform-origin:top left'
      hostEl.style.cssText = 'width:100%;height:100%'
    }
    const setViewerStyles = () => {
      scaleEl.style.cssText = 'position:absolute;left:50%;top:50%;transform-origin:center center'
      hostEl.style.cssText = 'width:auto;height:auto'
    }
    setDriverStyles()
    term.open(hostEl)
    enableTerminalWebgl(term)

    // Fit the natural (cols×rows) terminal into the container by uniform scale,
    // picking the smaller width/height ratio so nothing is clipped. Allowed to
    // scale up (>1) so a narrow phone-width terminal fills the big desktop pane.
    const rescaleViewer = () => {
      const nw = hostEl.offsetWidth
      const nh = hostEl.offsetHeight
      const aw = container.clientWidth
      const ah = container.clientHeight
      if (!nw || !nh || !aw || !ah) return
      const s = Math.min(aw / nw, ah / nh)
      scaleEl.style.transform = `translate(-50%,-50%) scale(${s})`
    }

    // All sizing — the initial fit, the font-load heal (the root-cause fix), and
    // every resize/visibility/DPR self-heal — is owned by the shared controller.
    // PTY resizes are gated on `ptyReady` so we never resize a session that does
    // not exist yet; the controller still keeps xterm itself fitted meanwhile.
    let ptyReady = false
    let restoring = false
    let lastSynced: Geometry | null = null
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const applyResizeSteps = async (steps: ReturnType<typeof planPtyResize>) => {
      for (const step of steps) {
        if (abortController.signal.aborted) return
        api.resizeTerminal(sessionId, step.cols, step.rows)
        if (step.settleMs > 0) await delay(step.settleMs)
      }
    }
    const autofit: AutoFitHandle = attachTerminalAutoFit(term, fitAddon, hostEl, {
      // Pause PTY fitting while maestro is active OR the web owns geometry — in
      // viewer mode the phone drives the size and the desktop must not fight it.
      isPaused: () =>
        restoring || useAppStore.getState().maestroMode || useAppStore.getState().remoteGeometryOwner === 'web',
      onSize: (geo) => {
        if (!ptyReady || abortController.signal.aborted) return
        // Only a genuine size change reaches the PTY — and that change is itself
        // the SIGWINCH that makes the TUI fully repaint, clearing the stale /
        // duplicate lines left by the pre-heal (fallback-font) frame. We do NOT
        // force-nudge on same-size font events: `loadingdone` fires repeatedly
        // and document-wide, so nudging there would cause needless resize churn.
        const steps = planPtyResize({ last: lastSynced, next: geo })
        if (steps.length === 0) return
        lastSynced = geo
        void applyResizeSteps(steps)
      },
    })

    // React to geometry-ownership handoffs mirrored into the store by App.tsx.
    let mode: 'driver' | 'viewer' = 'driver'
    const applyMode = () => {
      if (restoring) return
      const { remoteGeometryOwner: owner, remoteGeometry: geo } = useAppStore.getState()
      if (owner === 'web' && geo) {
        mode = 'viewer'
        setViewerStyles()
        try {
          term.resize(geo.cols, geo.rows)
        } catch {
          // renderer may be mid-frame — the observer/font hooks will rescale.
        }
        // offset sizes settle a frame after the resize + style flip.
        requestAnimationFrame(rescaleViewer)
      } else {
        mode = 'driver'
        setDriverStyles()
        scaleEl.style.transform = 'none'
        // Re-fit the PTY back to the desktop pane now that we own it again.
        //
        // Forget what we last sent first. While the phone owned the size the PTY
        // was resized behind our back (to the phone's viewport) but `lastSynced`
        // still holds the desktop size from before the handoff — so the re-fit
        // below measures that same desktop size, planPtyResize sees "no change"
        // and sends nothing, and the shell stays wrapped at phone width inside a
        // full-width terminal. Clearing it makes the next fit unconditional.
        // Hidden terminals fit to nothing here; they stay invalidated so their
        // first fit after becoming visible propagates too.
        lastSynced = null
        autofit.reconcile('manual')
      }
    }
    const scaleObserver = new ResizeObserver(() => {
      if (mode === 'viewer') rescaleViewer()
    })
    scaleObserver.observe(container)
    void document.fonts?.ready.then(() => { if (mode === 'viewer') rescaleViewer() }).catch(() => {})
    let prevOwner = useAppStore.getState().remoteGeometryOwner
    let prevGeo = useAppStore.getState().remoteGeometry
    const unsubGeometryOwner = useAppStore.subscribe((state) => {
      if (
        state.remoteGeometryOwner === prevOwner &&
        state.remoteGeometry?.cols === prevGeo?.cols &&
        state.remoteGeometry?.rows === prevGeo?.rows
      ) {
        return
      }
      prevOwner = state.remoteGeometryOwner
      prevGeo = state.remoteGeometry
      applyMode()
    })
    // Mount straight into viewer mode if the phone is already driving.
    if (useAppStore.getState().remoteGeometryOwner === 'web') applyMode()

    // Intercept macOS editing shortcuts that xterm.js ignores by default
    // (xterm passes Cmd+key and Option+key through to the browser)
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true

      // Ctrl+C or Escape → clear needs-input / agent-launch state so the UI
      // reflects the interrupt immediately.  Activity state is updated via
      // the hook event stream — no IPC hint needed.
      if ((e.key === 'c' && e.ctrlKey) || e.key === 'Escape') {
        const state = useAppStore.getState()
        const status = state.sessions[sessionId]?.processStatus
        if (status === 'claude' || status === 'codex' || status === 'cursor') {
          state.clearSessionNeedsUserInput(sessionId)
          state.clearAgentLaunch(sessionId)
        }
      }

      // Cmd+Left → beginning of line (Ctrl+A)
      if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        api.writeTerminal(sessionId!, '\x01')
        return false
      }
      // Cmd+Right → end of line (Ctrl+E)
      if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowRight') {
        e.preventDefault()
        api.writeTerminal(sessionId!, '\x05')
        return false
      }

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
      const { input: data, responses } = splitTerminalResponses(raw)
      const { sessions } = useAppStore.getState()
      const status = sessions[sessionId]?.processStatus
      if (responses && (status === 'claude' || status === 'codex' || status === 'cursor')) {
        api.writeTerminal(sessionId, responses, 'system')
      }
      if (!data) return
      api.writeTerminal(sessionId, data)
      const { startAgentRun } = useAppStore.getState()
      if (status === 'claude' || status === 'codex' || status === 'cursor') {
        const update = updateAgentInputBuffer(pendingAgentInput, data)
        pendingAgentInput = update.nextBuffer
        if (update.submittedPrompt) {
          startAgentRun(sessionId)
        }
      }
      // Clear "needs input" indicator as soon as the user presses Enter
      if (data.includes('\r') || data.includes('\n')) {
        const { sessionNeedsUserInput, clearSessionNeedsUserInput } = useAppStore.getState()
        if (sessionNeedsUserInput[sessionId]) {
          clearSessionNeedsUserInput(sessionId)
        }
      }
    })

    // Keep layout and snapshot parsing in one attachment transaction. A VT
    // snapshot contains cursor positions for its own grid; fitting halfway
    // through its async parse displaces the TUI until the next SIGWINCH.
    let snapshotApplied = false
    let pendingSnapshot: any | null = null
    let snapshotWaiter: (() => void) | null = null
    const pendingData: string[] = []
    const removeDataListener = api.onTerminalData((sid: string, data: string) => {
      if (sid !== sessionId) return
      if (!snapshotApplied) pendingData.push(data)
      else output.write(data)
    })
    const removeSnapshotListener = api.onTerminalSnapshot((sid: string, snapshot: any) => {
      if (sid !== sessionId || !snapshot) return
      pendingSnapshot = snapshot
      snapshotWaiter?.()
    })

    const layoutReady = waitForTerminalLayout(abortController.signal)
    let attachment: Promise<void> | null = null
    const attach = (): Promise<void> => {
      if (attachment) return attachment
      const pending = (async () => {
        await layoutReady
        if (abortController.signal.aborted) return
        // The first launch must use loaded font metrics and the laid-out pane,
        // including the attachment toolbar, rather than xterm's default 80×24.
        autofit.reconcile('manual')
        const requested = { cols: term.cols, rows: term.rows }
        if (ptyReady) {
          // Reattach the existing stream without resetting a live viewport.
          // Bytes sent before the snapshot boundary may already be rendered.
          await api.createTerminal(sessionId, { cwd, ...requested, initialCommand, launchProfile })
          return
        }
        restoring = true
        snapshotApplied = false
        pendingSnapshot = null
        await output.flush()
        if (abortController.signal.aborted) return
        const result = await createTerminalWithRetry(
          sessionId, { cwd, ...requested, initialCommand, launchProfile }, term, abortController.signal, () => { void attach() },
        )
        if (abortController.signal.aborted || !result) return
        if (result.restoredSnapshot) {
          if (!pendingSnapshot) {
            await new Promise<void>(resolve => {
              const timeout = setTimeout(() => { snapshotWaiter = null; resolve() }, 500)
              snapshotWaiter = () => { clearTimeout(timeout); snapshotWaiter = null; resolve() }
            })
          }
          if (abortController.signal.aborted) return
          // Main emits the paired snapshot before replying to create. Fetching
          // a newer snapshot here would duplicate bytes already in pendingData.
          const snapshot = pendingSnapshot
          if (!snapshot) throw new Error('The terminal snapshot did not arrive; activate this session to retry')
          if (snapshot) {
            if (isSaneGeometry(snapshot)) term.resize(snapshot.cols, snapshot.rows)
            term.reset()
            output.write((snapshot.rehydrateSequences ?? '') + (snapshot.snapshotAnsi ?? ''))
            await output.flush()
          }
        }
        if (abortController.signal.aborted) return
        // Warm agents still emit at their retained grid; a cold PTY may emit
        // at the requested grid even when the restored history is older.
        if (result.liveGeometry && isSaneGeometry(result.liveGeometry)) term.resize(result.liveGeometry.cols, result.liveGeometry.rows)
        snapshotApplied = true
        for (const chunk of pendingData.splice(0)) output.write(chunk)
        await output.flush()
        if (abortController.signal.aborted) return
        restoring = false
        ptyReady = true
        lastSynced = null
        applyMode()
      })().catch(error => {
        if (!abortController.signal.aborted) term.write(`\r\n[orchestra] Could not attach terminal: ${String(error)}\r\n`)
      }).finally(() => {
        restoring = false
        if (!abortController.signal.aborted && !snapshotApplied) {
          applyMode()
          snapshotApplied = true
          for (const chunk of pendingData.splice(0)) output.write(chunk)
        }
        if (attachment === pending) attachment = null
      })
      attachment = pending
      return pending
    }
    attachRef.current = attach
    void attach()

    termRef.current = term

    return () => {
      abortController.abort()
      attachRef.current = null
      snapshotWaiter?.()
      removeDataListener()
      removeSnapshotListener()
      unsubGeometryOwner()
      scaleObserver.disconnect()
      autofit.dispose()
      output.dispose()
      term.dispose()
      // Remove our scaler wrapper so a re-mount (session switch reusing this
      // TerminalInstance) doesn't stack a second scaleEl in the container.
      scaleEl.remove()
      termRef.current = null
    }
  }, [sessionId])

  useEffect(() => {
    if (!isActive || !sessionId || !termRef.current) return

    const ensureAttached = () => { void attachRef.current?.() }

    ensureAttached()
    window.addEventListener('focus', ensureAttached)
    return () => {
      window.removeEventListener('focus', ensureAttached)
    }
  }, [cwd, initialCommand, isActive, launchProfile, sessionId])

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


  // Clear stale mouse-tracking modes when a session returns from an agent to the
  // plain shell, so a TUI that was killed without resetting them doesn't leave
  // the terminal spraying mouse reports on every scroll. See MOUSE_TRACKING_RESET.
  useEffect(() => {
    if (!sessionId) return
    let prev = useAppStore.getState().sessions[sessionId]?.processStatus
    return useAppStore.subscribe((state) => {
      const next = state.sessions[sessionId]?.processStatus
      if (next === prev) return
      const returnedToShell = AGENT_PROCESS_STATUSES.has(prev ?? '') && next === 'terminal'
      prev = next
      if (returnedToShell) termRef.current?.write(MOUSE_TRACKING_RESET)
    })
  }, [sessionId])

  return termRef
}
