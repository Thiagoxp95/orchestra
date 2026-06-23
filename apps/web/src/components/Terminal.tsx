'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { nextChunks, type Chunk } from '../lib/chunk-buffer'
import {
  anyModifier,
  charBytes,
  NO_MODS,
  specialKeyBytes,
  type Modifiers,
} from '../lib/keyboard'
import { AgentKeyBar } from './AgentKeyBar'
import { ActionBar } from './ActionBar'
import { altScrollSequence } from '../lib/terminal-scroll'
import '@xterm/xterm/css/xterm.css'

// Match the desktop terminal so Nerd Font glyphs (powerline, git, devicons)
// render instead of tofu boxes. The family is @font-face'd in globals.css.
const TERMINAL_FONT = '"JetBrainsMono Nerd Font Mono", Menlo, Monaco, "Courier New", monospace'
const TERMINAL_FONT_SIZE = 13

// Pixels of vertical swipe per emitted scroll notch on the alt screen. Tuned so a
// finger drag scrolls a full-screen TUI at a comfortable rate (smaller = faster).
const ALT_SCROLL_STEP_PX = 18

export function TerminalPane({
  token,
  sessionId,
  onActionFired,
}: {
  token: string
  sessionId: string
  onActionFired: () => void
}) {
  const convex = useConvex()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [afterSeq, setAfterSeq] = useState(-1)

  // Sticky modifiers from the accessory key bar. A ref mirrors state so the
  // xterm onData handler (registered once per session) reads current values.
  const [mods, setMods] = useState<Modifiers>(NO_MODS)
  const modsRef = useRef<Modifiers>(NO_MODS)
  modsRef.current = mods

  const write = useCallback(
    (data: string) => {
      if (data) void convex.mutation(anyApi.remote.sendCommand, { token, sessionId, kind: 'write', payload: { data } })
    },
    [convex, token, sessionId],
  )

  const onToggleMod = useCallback((name: keyof Modifiers) => {
    setMods((m) => ({ ...m, [name]: !m[name] }))
  }, [])

  const onSpecial = useCallback(
    (key: string) => {
      write(specialKeyBytes(key))
      setMods(NO_MODS)
    },
    [write],
  )

  // Mount xterm + attach lifecycle.
  useEffect(() => {
    const term = new Terminal({
      convertEol: false,
      fontSize: TERMINAL_FONT_SIZE,
      fontFamily: TERMINAL_FONT,
      cursorBlink: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    termRef.current = term
    setAfterSeq(-1)

    const send = (kind: string, payload: unknown) =>
      void convex.mutation(anyApi.remote.sendCommand, { token, sessionId, kind, payload })

    // The first `attach` MUST carry this terminal's *post-layout* size. The bridge
    // resizes the daemon PTY to that size and serializes the seed snapshot at that
    // geometry; we then render the seed at whatever size this xterm actually is. If
    // we attach at a pre-layout size — a synchronous fit() right after term.open()
    // reads xterm's 80x24 fallback before the flex layout (host is flex-1 beside the
    // key/action bars) settles — the seed is serialized wide and replayed into a
    // narrow phone terminal. Its wrapped lines + relative cursor moves then land at
    // the wrong rows and the live alt-screen repaint stacks a second copy: doubled
    // banner/input box + leftover box-border fragments. So defer the fit and only
    // report a real, settled size.
    let disposed = false
    let attached = false
    let fontReady = false
    let lastCols = -1
    let lastRows = -1
    const fitAndSync = () => {
      const host = hostRef.current
      if (disposed || !host) return
      // Hold the very first attach until the Nerd Font has loaded (or timed out):
      // its cell metrics differ from the monospace fallback, so attaching before it
      // lands would serialize the seed at the wrong geometry and then need a resize
      // the moment the font swaps in — which a shell answers with a prompt redraw,
      // re-introducing the doubling. Resizes after attach are not gated.
      if (!attached && !fontReady) return
      const rect = host.getBoundingClientRect()
      // Bail until the host is actually laid out; the ResizeObserver re-runs us
      // once it has real dimensions.
      if (rect.width === 0 || rect.height === 0) return
      try {
        fit.fit()
      } catch {
        // xterm can throw from the renderer if the element detached mid-frame.
        return
      }
      if (term.cols === lastCols && term.rows === lastRows) return
      lastCols = term.cols
      lastRows = term.rows
      // First settled size → attach (seeds the screen). Later changes → resize.
      send(attached ? 'resize' : 'attach', { cols: term.cols, rows: term.rows })
      attached = true
    }

    const markFontReady = () => {
      if (disposed || fontReady) return
      fontReady = true
      // Re-assert fontFamily so xterm re-measures the cell size with the loaded font
      // before fit() computes cols/rows.
      term.options.fontFamily = TERMINAL_FONT
      fitAndSync()
    }
    // Pull the Nerd Font, then attach. Fall back to a short timeout so a slow
    // connection never leaves the terminal blank waiting on the font.
    void document.fonts
      ?.load(`${TERMINAL_FONT_SIZE}px "JetBrainsMono Nerd Font Mono"`)
      .then(markFontReady)
      .catch(markFontReady)
    const fontTimer = setTimeout(markFontReady, 1200)

    // Defer the first fit a frame: term.open() inits the renderer asynchronously and
    // the flex layout needs a beat to settle.
    const raf = requestAnimationFrame(fitAndSync)

    const onData = term.onData((data) => {
      const m = modsRef.current
      // Apply armed modifiers to a single printable char from the device keyboard.
      if (anyModifier(m) && data.length === 1) {
        send('write', { data: charBytes(data, m) })
        setMods(NO_MODS)
      } else {
        send('write', { data })
      }
    })

    // Touch scrolling. On the normal buffer xterm's viewport scrolls natively
    // (real scrollback) — we don't interfere. On the alternate buffer a full-screen
    // TUI has no scrollback, so a swipe must be sent to the program as the scroll
    // input it expects (mouse wheel, or arrows). Decide per-gesture at touchstart;
    // the buffer type doesn't change mid-swipe.
    let touchY: number | null = null
    let altGesture = false
    let scrollAccum = 0
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        touchY = null
        return
      }
      touchY = e.touches[0].clientY
      altGesture = term.buffer.active.type === 'alternate'
      scrollAccum = 0
    }
    const onTouchMove = (e: TouchEvent) => {
      if (touchY === null || !altGesture || e.touches.length !== 1) return
      const y = e.touches[0].clientY
      scrollAccum += y - touchY
      touchY = y
      let notches = 0
      while (scrollAccum >= ALT_SCROLL_STEP_PX) {
        scrollAccum -= ALT_SCROLL_STEP_PX
        notches++
      }
      while (scrollAccum <= -ALT_SCROLL_STEP_PX) {
        scrollAccum += ALT_SCROLL_STEP_PX
        notches--
      }
      if (notches === 0) return
      // Take over the gesture so the browser doesn't also pan, and feed the TUI.
      e.preventDefault()
      // Finger moving down (notches > 0) reveals earlier content → scroll up.
      const up = notches > 0
      const seq = altScrollSequence(
        {
          mouseTracking: term.modes.mouseTrackingMode !== 'none',
          applicationCursor: term.modes.applicationCursorKeysMode,
        },
        up,
      )
      for (let i = 0; i < Math.abs(notches); i++) send('write', { data: seq })
    }
    const onTouchEnd = () => {
      touchY = null
      altGesture = false
      scrollAccum = 0
    }
    const termEl = term.element
    // touchmove must be non-passive so preventDefault() can suppress the browser
    // pan on the alt screen.
    termEl?.addEventListener('touchstart', onTouchStart, { passive: true })
    termEl?.addEventListener('touchmove', onTouchMove, { passive: false })
    termEl?.addEventListener('touchend', onTouchEnd, { passive: true })
    termEl?.addEventListener('touchcancel', onTouchEnd, { passive: true })

    // A ResizeObserver (not window 'resize') is required: window 'resize' does not
    // fire when the flex siblings (key bar + action bar) mount/measure or when the
    // mobile URL bar shows/hides — which is exactly when our true size changes.
    // Debounced to avoid a burst of resizes during layout/animation.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(fitAndSync, 80)
    })
    ro.observe(hostRef.current!)

    return () => {
      disposed = true
      send('detach', {})
      onData.dispose()
      termEl?.removeEventListener('touchstart', onTouchStart)
      termEl?.removeEventListener('touchmove', onTouchMove)
      termEl?.removeEventListener('touchend', onTouchEnd)
      termEl?.removeEventListener('touchcancel', onTouchEnd)
      cancelAnimationFrame(raf)
      clearTimeout(fontTimer)
      if (resizeTimer) clearTimeout(resizeTimer)
      ro.disconnect()
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
    <div className="flex h-full flex-col">
      <div ref={hostRef} className="min-h-0 flex-1 bg-black p-1" />
      <AgentKeyBar mods={mods} onToggleMod={onToggleMod} onSpecial={onSpecial} />
      <ActionBar token={token} onActionFired={onActionFired} />
    </div>
  )
}
