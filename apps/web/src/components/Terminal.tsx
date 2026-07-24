'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Check, Copy, X } from 'lucide-react'
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
import { terminalBg, terminalTheme } from '../lib/terminal-theme'
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
  owner,
  color,
  onActionFired,
}: {
  token: string
  sessionId: string
  /**
   * Authoritative PTY geometry mirrored from the bridge. In VIEWER mode (owner
   * 'desktop') the phone adopts it and scales; in DRIVER mode (owner 'web') the
   * phone owns the size, renders 1:1, and this just echoes its own claim.
   */
  cols?: number
  rows?: number
  /** Who currently drives the shared PTY size (mirrored from the bridge). */
  owner: 'desktop' | 'web'
  /**
   * The active workspace's color (mirrored from the bridge). Drives the xterm
   * theme so the web terminal recolors per workspace exactly like the desktop.
   */
  color?: string
  /** Arms the page's auto-attach for the workspace the fired action targets. */
  onActionFired: (workspaceId: string | null) => void
}) {
  const convex = useConvex()
  const hostRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  // Latest desktop geometry, read inside the (sessionId-keyed) mount effect.
  const geoRef = useRef<{ cols?: number; rows?: number }>({ cols, rows })
  // Latest ownership, read inside the mount effect to pick driver vs viewer.
  const ownerRef = useRef<'desktop' | 'web'>(owner)
  // Lets the geometry-follow effect poke the mount effect's apply fn on prop change.
  const applyGeometryRef = useRef<(() => void) | null>(null)
  const [afterSeq, setAfterSeq] = useState(-1)
  // Set once any chunk has been written, so the attach watchdog knows the stream
  // is live and stops re-firing `attach`.
  const firstChunkRef = useRef(false)
  // Whether the user is reading the live bottom of the buffer (as opposed to
  // having scrolled back through the scrollback). Drives the re-pin after a
  // geometry change — see pinBottom in the mount effect.
  const followBottomRef = useRef(true)

  // Sticky modifiers from the accessory key bar. A ref mirrors state so the
  // xterm onData handler (registered once per session) reads current values.
  const [mods, setMods] = useState<Modifiers>(NO_MODS)
  const modsRef = useRef<Modifiers>(NO_MODS)
  modsRef.current = mods

  const {
    isDictating,
    isProcessing: isDictationProcessing,
    error: dictationError,
    start: onDictateStart,
    stop: onDictateStop,
  } = useDictation(token, sessionId)

  // Latest workspace color, read inside the (sessionId-keyed) mount effect for the
  // initial theme; a separate effect below live-updates the theme when it changes.
  const colorRef = useRef<string | undefined>(color)
  colorRef.current = color

  // Long-press drag selection: reflects whether xterm currently holds a
  // selection (drives the floating Copy button) and a brief post-copy toast.
  const [hasSelection, setHasSelection] = useState(false)
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onCopy = useCallback(async () => {
    const term = termRef.current
    const text = term?.getSelection()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return // clipboard blocked; leave the selection so the user can retry
    }
    setCopied(true)
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = setTimeout(() => {
      setCopied(false)
      termRef.current?.clearSelection()
    }, 1000)
  }, [])

  const onClearSelection = useCallback(() => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    setCopied(false)
    termRef.current?.clearSelection()
  }, [])

  useEffect(() => () => { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current) }, [])

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
      // The mirror's hidden textarea is never focused (input is relayed through
      // Convex from the key bar / soft keyboard, and touch handlers don't focus
      // xterm), so xterm always renders its *blurred* cursor. Default blurred
      // style is a hollow 'outline' box, which sat apart from the TUI's own
      // reverse-video cursor and read as a stray, misplaced cursor. Match the
      // desktop: render the inactive cursor as a solid block on the same cell.
      cursorInactiveStyle: 'block',
      // Per-workspace theme, derived identically to the desktop so background,
      // foreground, and cursor match. A live-update effect below re-applies it
      // when the active workspace (color) changes without remounting.
      theme: terminalTheme(colorRef.current),
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(hostRef.current!)
    termRef.current = term
    setAfterSeq(-1)
    firstChunkRef.current = false

    const send = (kind: string, payload: unknown) =>
      void convex.mutation(anyApi.remote.sendCommand, { token, sessionId, kind, payload })

    // The phone has two modes over the single shared PTY (see remote-bridge
    // geometry ownership):
    //  - DRIVER (owner 'web'): a focused phone owns the PTY size. Fit xterm to the
    //    real viewport at the readable font, send that as a `claimGeometry` so the
    //    bridge resizes every PTY to it, and render 1:1 — content reflows to the
    //    phone width instead of being shrunk to microscopic.
    //  - VIEWER (owner 'desktop'): the desktop drives the size; adopt the mirrored
    //    (cols,rows) and CSS-scale to fit, never resizing the PTY (that fought the
    //    desktop's ResizeObserver and garbled the mirror). Seed-geometry invariant
    //    holds in both modes: the snapshot is serialized at whatever size we render.
    let disposed = false
    let attached = false
    let fontReady = false
    const isDriver = () => ownerRef.current === 'web'

    const setDriverStyles = () => {
      const s = scaleRef.current
      const h = hostRef.current
      if (s) { s.style.inset = '0'; s.style.transform = 'none'; s.style.transformOrigin = 'top left' }
      if (h) { h.style.width = '100%'; h.style.height = '100%' }
    }
    const setViewerStyles = () => {
      const s = scaleRef.current
      const h = hostRef.current
      if (s) { s.style.inset = 'auto'; s.style.left = '0'; s.style.top = '0'; s.style.transformOrigin = 'top left' }
      if (h) { h.style.width = 'auto'; h.style.height = 'auto' }
    }

    // Resizing the terminal moves its scroller under xterm: the scrollable's pixel
    // position and the buffer's ydisp get reconciled across the change, and the
    // scrolls that fall out of that are xterm bookkeeping, not the user choosing
    // where to read. The soft keyboard makes it loud — opening it shrinks the shell
    // by ~a screen, so the reconcile can park the view a screenful up the
    // scrollback, and since xterm only follows output while it believes it's at the
    // bottom, every later write then lands below the fold as well: you start typing
    // and the live prompt is simply gone until you scroll back down.
    //
    // The cure is to re-pin the bottom after every geometry change — but only for a
    // user who was at the bottom, so someone reading back through scrollback isn't
    // yanked forward. Hence: only a finger (or a wheel) can stop us following.
    // Bookkeeping scrolls never do, whether they land before or after the resize.
    const USER_SCROLL_MS = 1200 // covers touch momentum after the finger lifts
    let userScrollUntil = 0
    const markUserScroll = () => {
      userScrollUntil = Date.now() + USER_SCROLL_MS
    }
    const pinBottom = () => {
      if (disposed || !followBottomRef.current) return
      term.scrollToBottom()
      // xterm re-syncs its scroller in a render callback (next frame), so pin once
      // more after that has landed or the resize drags the view back up.
      requestAnimationFrame(() => {
        if (!disposed && followBottomRef.current) term.scrollToBottom()
      })
    }
    const onScroll = term.onScroll(() => {
      if (disposed) return
      const b = term.buffer.active
      // Arriving at the bottom always means "follow the live output" again.
      if (b.viewportY >= b.baseY) {
        followBottomRef.current = true
        return
      }
      if (Date.now() >= userScrollUntil) return
      followBottomRef.current = false
      markUserScroll() // momentum keeps scrolling after the finger is gone
    })

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

    // Claim ownership: measure the phone's viewport in cols×rows (at the readable
    // font) and tell the bridge to resize every PTY to it. Works from EITHER mode
    // — it temporarily sizes the host to the viewport so FitAddon measures the
    // real available space, then restores the current mode's rendering. This lets
    // a viewer (owner 'desktop') take over on tap/focus, and lets the very first
    // render claim before the mirror has ever said owner 'web'.
    const sendClaim = () => {
      if (disposed || document.visibilityState !== 'visible') return
      const restoreViewer = !isDriver()
      setDriverStyles()
      let cols = 0
      let rows = 0
      try {
        fitAddon.fit()
        cols = term.cols
        rows = term.rows
      } catch {
        // renderer may be mid-frame
      }
      if (restoreViewer) applyGeometry()
      else if (scaleRef.current) scaleRef.current.style.transform = 'none'
      pinBottom()
      if (cols > 0 && rows > 0) {
        send('claimGeometry', { cols, rows })
      }
    }

    // Bring xterm to the right size for the current mode. Driver: fill the
    // viewport and fit (1:1). Viewer: adopt the mirrored geometry and scale.
    const applyGeometry = () => {
      if (disposed) return
      if (isDriver()) {
        setDriverStyles()
        try {
          fitAddon.fit()
        } catch {
          // renderer may be mid-frame
        }
        if (scaleRef.current) scaleRef.current.style.transform = 'none'
        pinBottom()
        return
      }
      setViewerStyles()
      const { cols: gc, rows: gr } = geoRef.current
      if (gc && gr && (term.cols !== gc || term.rows !== gr)) {
        try {
          term.resize(gc, gr)
        } catch {
          // ignore — renderer may be mid-frame
        }
      }
      rescale()
      pinBottom()
    }

    const maybeAttach = () => {
      if (disposed || attached || !fontReady) return
      // Size to the current mode before seeding so the seed (serialized at that
      // geometry) replays into a matching client.
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
      // Stake an ownership claim as the active viewer on first render, before
      // attaching, so the bridge resizes the PTY to this viewport before seeding.
      sendClaim()
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

    // Re-claim ownership whenever the phone becomes the active viewer (tab focus
    // or foreground). The bridge grants it, resizes every PTY to this viewport,
    // and mirrors owner='web' back — which flips us into driver render mode.
    const onFocusOrVisible = () => {
      if (document.visibilityState !== 'visible') return
      sendClaim()
    }
    window.addEventListener('focus', onFocusOrVisible)
    document.addEventListener('visibilitychange', onFocusOrVisible)

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

    // Mirror xterm's selection into React so the floating Copy button appears
    // exactly while a long-press selection is live.
    const onSel = term.onSelectionChange(() => setHasSelection(term.hasSelection()))

    // Touch does three things depending on the gesture:
    //  - normal buffer: xterm's viewport scrolls natively (real scrollback).
    //  - alternate buffer: a full-screen TUI has no scrollback, so a swipe is
    //    translated into the scroll input the program expects (wheel/arrows).
    //  - long-press then drag (either buffer): select text to copy. A press held
    //    in place for LONG_PRESS_MS anchors a selection at the touched cell;
    //    dragging extends it (and suppresses scrolling); release keeps it so the
    //    floating Copy button can act. Scroll vs select is decided per-gesture.
    let touchY: number | null = null
    let altGesture = false
    let scrollAccum = 0
    let longPressTimer: ReturnType<typeof setTimeout> | null = null
    let selecting = false
    let anchor: { col: number; row: number } | null = null
    let pressX = 0
    let pressY = 0
    const LONG_PRESS_MS = 400
    const MOVE_CANCEL_PX = 10

    const cancelLongPress = () => {
      if (longPressTimer) clearTimeout(longPressTimer)
      longPressTimer = null
    }

    // Map a viewport touch point to an absolute buffer cell. Measures against the
    // on-screen (post-transform) rect of the rows layer, so the CSS scale used in
    // viewer mode is handled implicitly — no need to know the scale factor.
    const cellFromTouch = (clientX: number, clientY: number): { col: number; row: number } | null => {
      const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null
      if (!screen) return null
      const rect = screen.getBoundingClientRect()
      if (!rect.width || !rect.height) return null
      const col = Math.max(0, Math.min(term.cols - 1, Math.floor((clientX - rect.left) / (rect.width / term.cols))))
      const vrow = Math.max(0, Math.min(term.rows - 1, Math.floor((clientY - rect.top) / (rect.height / term.rows))))
      return { col, row: term.buffer.active.viewportY + vrow }
    }

    // Select the inclusive run of cells between the anchor and the current focus,
    // ordering them so the earlier point starts the run (select() wants length ≥ 0).
    const extendSelection = (focus: { col: number; row: number }) => {
      if (!anchor) return
      const anchorFirst =
        anchor.row < focus.row || (anchor.row === focus.row && anchor.col <= focus.col)
      const start = anchorFirst ? anchor : focus
      const end = anchorFirst ? focus : anchor
      const length = (end.row - start.row) * term.cols + (end.col - start.col) + 1
      term.select(start.col, start.row, Math.max(1, length))
    }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        touchY = null
        cancelLongPress()
        return
      }
      touchY = e.touches[0].clientY
      altGesture = term.buffer.active.type === 'alternate'
      scrollAccum = 0
      pressX = e.touches[0].clientX
      pressY = e.touches[0].clientY
      // Arm long-press selection; a move before it fires (below) disarms it.
      cancelLongPress()
      longPressTimer = setTimeout(() => {
        longPressTimer = null
        const cell = cellFromTouch(pressX, pressY)
        if (!cell) return
        selecting = true
        anchor = cell
        altGesture = false // this gesture is a selection, not a scroll
        navigator.vibrate?.(10)
        term.select(cell.col, cell.row, 1)
      }, LONG_PRESS_MS)
      // Tapping the terminal is a strong "I'm the active viewer" signal — reclaim
      // geometry from the desktop (mobile 'focus'/'visibilitychange' don't fire
      // reliably for an already-foreground PWA). Only when not already driving, so
      // scrolling while we own the size doesn't churn re-seeds.
      if (!isDriver()) sendClaim()
    }
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      // A finger on the terminal is the one thing allowed to stop us following the
      // live bottom (see onScroll): the native scrollback pan it drives arrives as
      // scroll events indistinguishable from xterm's own resize bookkeeping.
      markUserScroll()
      // Drag-to-extend once a selection has been anchored.
      if (selecting) {
        e.preventDefault()
        const cell = cellFromTouch(e.touches[0].clientX, e.touches[0].clientY)
        if (cell) extendSelection(cell)
        return
      }
      // Real movement before the long-press fires means this is a scroll/pan.
      if (longPressTimer) {
        const t = e.touches[0]
        if (Math.abs(t.clientX - pressX) > MOVE_CANCEL_PX || Math.abs(t.clientY - pressY) > MOVE_CANCEL_PX) {
          cancelLongPress()
        }
      }
      if (touchY === null || !altGesture) return
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
      cancelLongPress()
      touchY = null
      altGesture = false
      scrollAccum = 0
      selecting = false
      anchor = null // end the drag but keep the selection for the Copy button
    }
    const termEl = term.element
    // touchmove must be non-passive so preventDefault() can suppress the browser
    // pan on the alt screen.
    termEl?.addEventListener('touchstart', onTouchStart, { passive: true })
    termEl?.addEventListener('touchmove', onTouchMove, { passive: false })
    termEl?.addEventListener('touchend', onTouchEnd, { passive: true })
    termEl?.addEventListener('touchcancel', onTouchEnd, { passive: true })
    // The mirror is usable from a desktop browser too, where scrollback is a wheel.
    termEl?.addEventListener('wheel', markUserScroll, { passive: true })

    // A ResizeObserver (not window 'resize') is required: window 'resize' does not
    // fire when the flex siblings (key bar + action bar) mount/measure or when the
    // mobile URL bar shows/hides — which is exactly when our viewport changes.
    // Debounced to avoid a burst during layout/animation. In viewer mode we re-fit
    // the scale; in driver mode a real viewport change means the PTY should resize,
    // so we re-claim.
    // Safari scrolls every scrollable ancestor of a focused element to reveal it
    // when the soft keyboard opens, and xterm's helper textarea rides along at the
    // cursor cell (at `left: -9999em` before its first sync). The letterbox is
    // overflow-hidden — still programmatically scrollable — so that reveal can
    // shift the whole terminal out of the clip box with no gesture to bring it
    // back. It never has anything worth scrolling to; keep it at the origin.
    const letterbox = viewportRef.current!
    const onLetterboxScroll = () => {
      if (letterbox.scrollTop !== 0) letterbox.scrollTop = 0
      if (letterbox.scrollLeft !== 0) letterbox.scrollLeft = 0
    }
    letterbox.addEventListener('scroll', onLetterboxScroll)

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        maybeAttach()
        applyGeometry()
        if (isDriver()) sendClaim()
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
      cancelLongPress()
      send('detach', {})
      onData.dispose()
      onSel.dispose()
      onScroll.dispose()
      letterbox.removeEventListener('scroll', onLetterboxScroll)
      window.removeEventListener('focus', onFocusOrVisible)
      document.removeEventListener('visibilitychange', onFocusOrVisible)
      termEl?.removeEventListener('touchstart', onTouchStart)
      termEl?.removeEventListener('touchmove', onTouchMove)
      termEl?.removeEventListener('touchend', onTouchEnd)
      termEl?.removeEventListener('touchcancel', onTouchEnd)
      termEl?.removeEventListener('wheel', markUserScroll)
      cancelAnimationFrame(raf)
      clearTimeout(fontTimer)
      if (resizeTimer) clearTimeout(resizeTimer)
      ro.disconnect()
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Follow the mirrored geometry AND ownership: when either changes, update the
  // refs the mount effect reads and re-apply. An owner flip (desktop reclaimed, or
  // our own claim was granted) switches between driver (1:1) and viewer (scale).
  useEffect(() => {
    geoRef.current = { cols, rows }
    ownerRef.current = owner
    applyGeometryRef.current?.()
  }, [cols, rows, owner])

  // Recolor xterm when the active workspace color changes (navigating between
  // workspaces), matching the desktop's [termBg] theme-update effect. Also repaint
  // the letterbox viewport (visible around the scaled terminal in viewer mode) so
  // the padding matches the terminal background instead of a hardcoded black.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(color)
    if (viewportRef.current) viewportRef.current.style.backgroundColor = terminalBg(color)
  }, [color])

  // Stream chunks → xterm.
  const chunks = useQuery(anyApi.remote.getChunks, { token, sessionId, afterSeq }) as Chunk[] | undefined
  useEffect(() => {
    if (!chunks || chunks.length === 0 || !termRef.current) return
    const { data, afterSeq: next, reset } = nextChunks(chunks, afterSeq)
    // A seed chunk is a full-screen repaint: clear xterm first so a re-seed
    // (second viewer, desktop wake re-seed, respawn) repaints cleanly instead
    // of layering onto stale content.
    // A seed wipes the buffer the user was reading, so whatever scrollback
    // position they held is gone with it — start following the bottom again.
    if (reset) {
      termRef.current.reset()
      followBottomRef.current = true
    }
    if (data) {
      // Follow the live output while the user is at the bottom. xterm does this
      // itself, but only while its scroller agrees it's at the bottom — a resize
      // (soft keyboard) can leave the two out of step, and then the stream would
      // silently render below the fold. See pinBottom in the mount effect.
      termRef.current.write(data, () => {
        if (followBottomRef.current) termRef.current?.scrollToBottom()
      })
      firstChunkRef.current = true // tells the attach watchdog the stream is live
    }
    if (next !== afterSeq) setAfterSeq(next)
  }, [chunks, afterSeq])

  return (
    <div className="flex h-full flex-col">
      {/* Viewport clips the scaled terminal; the scaler shrinks the desktop-width
          xterm to fit without resizing the shared PTY. select-none + no touch
          callout so a long-press starts our drag-selection, not the OS text menu. */}
      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 select-none overflow-hidden"
        style={{ WebkitTouchCallout: 'none', backgroundColor: terminalBg(color) }}
      >
        <div ref={scaleRef} className="absolute left-0 top-0 origin-top-left">
          <div ref={hostRef} />
        </div>
        {hasSelection && (
          <div className="absolute right-2 top-2 z-10 flex gap-1.5">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void onCopy()}
              className="flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-lg active:bg-blue-700"
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              aria-label="Clear selection"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onClearSelection}
              className="flex items-center justify-center rounded-md bg-black/70 px-2 py-1.5 text-white shadow-lg active:bg-black/90"
            >
              <X className="size-4" />
            </button>
          </div>
        )}
        {(isDictating || isDictationProcessing || dictationError) && (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 rounded-md bg-black/70 px-3 py-2 text-sm text-white/90 backdrop-blur">
            {dictationError ? (
              <span className="text-red-300">🎤 {dictationError}</span>
            ) : isDictationProcessing ? (
              <span>
                <span className="mr-1 animate-pulse">✍️</span>
                Transcribing…
              </span>
            ) : (
              <span>
                <span className="mr-1 animate-pulse">🎤</span>
                Listening…
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
        isDictationProcessing={isDictationProcessing}
        onDictateStart={onDictateStart}
        onDictateStop={onDictateStop}
      />
      <ActionBar token={token} sessionId={sessionId} onActionFired={onActionFired} />
    </div>
  )
}
