'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { Terminal } from '@xterm/xterm'
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
import { useDictation } from '../hooks/useDictation'
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
  cols,
  rows,
  onActionFired,
}: {
  token: string
  sessionId: string
  /** Desktop PTY geometry mirrored from the bridge. The phone adopts it and scales. */
  cols?: number
  rows?: number
  onActionFired: () => void
}) {
  const convex = useConvex()
  const hostRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  // Latest desktop geometry, read inside the (sessionId-keyed) mount effect.
  const geoRef = useRef<{ cols?: number; rows?: number }>({ cols, rows })
  // Lets the geometry-follow effect poke the mount effect's apply fn on prop change.
  const applyGeometryRef = useRef<(() => void) | null>(null)
  const [afterSeq, setAfterSeq] = useState(-1)
  // Set once any chunk has been written, so the attach watchdog knows the stream
  // is live and stops re-firing `attach`.
  const firstChunkRef = useRef(false)

  // Sticky modifiers from the accessory key bar. A ref mirrors state so the
  // xterm onData handler (registered once per session) reads current values.
  const [mods, setMods] = useState<Modifiers>(NO_MODS)
  const modsRef = useRef<Modifiers>(NO_MODS)
  modsRef.current = mods

  const { isDictating, interimText, error: dictationError, start: onDictateStart, stop: onDictateStop } =
    useDictation(token, sessionId)

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
    term.open(hostRef.current!)
    termRef.current = term
    setAfterSeq(-1)
    firstChunkRef.current = false

    const send = (kind: string, payload: unknown) =>
      void convex.mutation(anyApi.remote.sendCommand, { token, sessionId, kind, payload })

    // The phone is a VIEWER: it does not resize the shared PTY (that fought the
    // desktop's own ResizeObserver over the single PTY and left the mirror
    // garbled). Instead it adopts the desktop's geometry — mirrored as (cols,rows)
    // — sizes its xterm to exactly that, and CSS-scales the result to fit the
    // viewport. That keeps the seed-geometry invariant (snapshot size == client
    // size) so there's no doubling, and the desktop is never reflowed to phone
    // width. We only ever send `attach` (once), never `resize`.
    let disposed = false
    let attached = false
    let fontReady = false

    // Fit the (cols×rows) xterm into the viewport by uniform scale, picking the
    // smaller of the width/height ratios so nothing is clipped (the agent's input
    // box lives on the bottom row — clipping it would be worse than small text).
    const rescale = () => {
      const viewport = viewportRef.current
      const scaleEl = scaleRef.current
      const xtermEl = term.element
      if (disposed || !viewport || !scaleEl || !xtermEl) return
      // offsetWidth/Height are the pre-transform layout size, so they read the
      // terminal's natural pixel size regardless of any scale already applied.
      const naturalW = xtermEl.offsetWidth
      const naturalH = xtermEl.offsetHeight
      const availW = viewport.clientWidth
      const availH = viewport.clientHeight
      if (!naturalW || !naturalH || !availW || !availH) return
      const scale = Math.min(availW / naturalW, availH / naturalH)
      scaleEl.style.transform = `scale(${scale})`
    }

    // Apply the desktop geometry to the xterm (and rescale). Called on first
    // settle, on font load, on viewport resize, and whenever the mirrored
    // geometry changes.
    const applyGeometry = () => {
      if (disposed) return
      const { cols: gc, rows: gr } = geoRef.current
      if (gc && gr && (term.cols !== gc || term.rows !== gr)) {
        try {
          term.resize(gc, gr)
        } catch {
          // ignore — renderer may be mid-frame
        }
      }
      rescale()
    }

    const maybeAttach = () => {
      if (disposed || attached || !fontReady) return
      // Adopt the desktop geometry before seeding so the seed (serialized at that
      // geometry) replays into a matching client. If geometry isn't mirrored yet
      // we still attach — the bridge pushes the snapshot's geometry on attach and
      // applyGeometry corrects us when it lands.
      applyGeometry()
      attached = true
      send('attach', { cols: term.cols, rows: term.rows })
    }

    const markFontReady = () => {
      if (disposed || fontReady) return
      fontReady = true
      // Re-assert fontFamily so xterm re-measures the cell size with the loaded font.
      term.options.fontFamily = TERMINAL_FONT
      applyGeometry()
      maybeAttach()
    }
    // Pull the Nerd Font, then attach. Fall back to a short timeout so a slow
    // connection never leaves the terminal blank waiting on the font.
    void document.fonts
      ?.load(`${TERMINAL_FONT_SIZE}px "JetBrainsMono Nerd Font Mono"`)
      .then(markFontReady)
      .catch(markFontReady)
    const fontTimer = setTimeout(markFontReady, 1200)

    // Defer the first geometry apply a frame: term.open() inits the renderer
    // asynchronously and the flex layout needs a beat to settle.
    const raf = requestAnimationFrame(applyGeometry)
    // Expose the scaler so the geometry-follow effect can re-apply on prop change.
    applyGeometryRef.current = applyGeometry

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
    // mobile URL bar shows/hides — which is exactly when our viewport changes.
    // Debounced to avoid a burst during layout/animation. We re-fit the scale (and
    // attach once the layout has settled) — we never resize the PTY.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        maybeAttach()
        applyGeometry()
      }, 80)
    })
    ro.observe(viewportRef.current!)

    // Attach watchdog: the first `attach` (or its seed) can be lost — the command
    // row pruned before the bridge consumed it, a stale bridge socket, or a
    // dropped seed mutation — leaving the viewer on a black screen with no
    // recovery. If no chunk has arrived a few seconds after we attached, re-fire
    // `attach` so the bridge re-seeds. Bounded so a legitimately empty snapshot
    // doesn't loop forever.
    let attachAttempts = 0
    const attachWatchdog = setInterval(() => {
      if (disposed || firstChunkRef.current || !attached) return
      if (attachAttempts >= 4) return
      attachAttempts++
      send('attach', { cols: term.cols, rows: term.rows })
    }, 2500)

    return () => {
      disposed = true
      applyGeometryRef.current = null
      clearInterval(attachWatchdog)
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

  // Follow the desktop's geometry: when the mirrored (cols,rows) change, update the
  // ref the mount effect reads and re-apply (resize xterm + rescale to fit).
  useEffect(() => {
    geoRef.current = { cols, rows }
    applyGeometryRef.current?.()
  }, [cols, rows])

  // Stream chunks → xterm.
  const chunks = useQuery(anyApi.remote.getChunks, { token, sessionId, afterSeq }) as Chunk[] | undefined
  useEffect(() => {
    if (!chunks || chunks.length === 0 || !termRef.current) return
    const { data, afterSeq: next, reset } = nextChunks(chunks, afterSeq)
    // A seed chunk is a full-screen repaint: clear xterm first so a re-seed
    // (second viewer, desktop wake re-seed, respawn) repaints cleanly instead
    // of layering onto stale content.
    if (reset) termRef.current.reset()
    if (data) {
      termRef.current.write(data)
      firstChunkRef.current = true // tells the attach watchdog the stream is live
    }
    if (next !== afterSeq) setAfterSeq(next)
  }, [chunks, afterSeq])

  return (
    <div className="flex h-full flex-col">
      {/* Viewport clips the scaled terminal; the scaler shrinks the desktop-width
          xterm to fit without resizing the shared PTY. */}
      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <div ref={scaleRef} className="absolute left-0 top-0 origin-top-left">
          <div ref={hostRef} />
        </div>
        {(isDictating || interimText || dictationError) && (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 rounded-md bg-black/70 px-3 py-2 text-sm text-white/90 backdrop-blur">
            {dictationError ? (
              <span className="text-red-300">🎤 {dictationError}</span>
            ) : (
              <span>
                <span className="mr-1 animate-pulse">🎤</span>
                {interimText || 'Listening…'}
              </span>
            )}
          </div>
        )}
      </div>
      <AgentKeyBar
        token={token}
        sessionId={sessionId}
        mods={mods}
        onToggleMod={onToggleMod}
        onSpecial={onSpecial}
        isDictating={isDictating}
        onDictateStart={onDictateStart}
        onDictateStop={onDictateStop}
      />
      <ActionBar token={token} onActionFired={onActionFired} />
    </div>
  )
}
