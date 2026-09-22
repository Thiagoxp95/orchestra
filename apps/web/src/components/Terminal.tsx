'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { ArrowDown, Check, Copy, X } from 'lucide-react'
import { bindTerminalInput } from '../../../desktop/src/shared/terminal-stream/user-input'
import { TerminalApplier } from '../lib/terminal-stream/applier'
import { TerminalConnection } from '../lib/terminal-stream/connection'
import { subscribeTerminalLifecycle } from '../lib/terminal-stream/lifecycle'
import {
  createModifierKeys,
  inputBytes,
  NO_MODS,
  specialKeyBytes,
  type Modifiers,
} from '../lib/keyboard'
import { AgentKeyBar } from './AgentKeyBar'
import { UsageStrip } from './UsageStrip'
import { useDictation } from '../hooks/useDictation'
import { createTerminalScroller } from '../lib/terminal-kinetics'
import { createTerminalWriter } from '../lib/terminal-writer'
import { altScrollSequence, createAltScrollQueue, jumpNotches } from '../lib/terminal-scroll'
import { releaseHiddenKeyboardFocus } from '../lib/viewport'
import { terminalBg, terminalTheme } from '../lib/terminal-theme'
import { fitScale, isSaneGeometry, type Geometry } from '../lib/terminal-geometry'
import '@xterm/xterm/css/xterm.css'

// Match the desktop terminal so Nerd Font glyphs (powerline, git, devicons)
// render instead of tofu boxes. The family is @font-face'd in globals.css.
const TERMINAL_FONT = '"JetBrainsMono Nerd Font Mono", Menlo, Monaco, "Courier New", monospace'
const TERMINAL_FONT_SIZE = 14

// Pixels of vertical swipe per emitted scroll notch on the alt screen. Tuned so a
// finger drag scrolls a full-screen TUI at a comfortable rate (smaller = faster).
const ALT_SCROLL_STEP_PX = 18

// The jump-to-latest burst is the one alt-screen scroll allowed past the pool's
// ceiling: it is a single write the reader asked for once, not a gesture still
// arriving. The slack rides past the notches we know about; the max keeps a long
// reading session from turning into a write the size of a novel.
const ALT_JUMP_SLACK_NOTCHES = 12
const ALT_JUMP_MAX_NOTCHES = 240

export function TerminalPane({
  sessionId,
  cols,
  rows,
  owner,
  color,
  claimNonce,
  onActionFired,
}: {
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
  /**
   * Bumped when the user taps the worktree name in the header — the phone's
   * explicit "size this session to me". Each new value re-sends a geometry
   * claim; the value itself carries no meaning.
   */
  claimNonce: number
  /** Arms the page's auto-attach for the workspace the fired action targets. */
  onActionFired: (workspaceId: string | null) => void

}) {
  // The desktop reports this when its session daemon can't stream — which in
  // practice means the daemon is down. There is nothing to fall back to, so it
  // is surfaced rather than worked around.
  const [unsupported, setUnsupported] = useState(false)
  const connectionRef = useRef<TerminalConnection | null>(null)
  const [controller, setController] = useState(false)
  const [streamStatus, setStreamStatus] = useState('')
  const [historyExpired, setHistoryExpired] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const writerRef = useRef<ReturnType<typeof createTerminalWriter> | null>(null)
  const stopScrollRef = useRef<(() => void) | null>(null)
  const [following, setFollowing] = useState(true)
  // The alt screen's half of "am I at the live end". xterm's scroll position
  // answers that for the normal buffer, but a full-screen TUI owns its own
  // scroll and reports nothing back — so the notches we sent it on the way up
  // are the only record that the reader left the bottom, and the distance back.
  const altBackRef = useRef(0)
  const [altScrolledBack, setAltScrolledBack] = useState(false)
  // Set by the mount effect: jumping closes over xterm and the alt-scroll pool.
  const jumpLatestRef = useRef<(() => void) | null>(null)
  const [inputError, setInputError] = useState<string | null>(null)
  // Latest desktop geometry, read inside the (sessionId-keyed) mount effect.
  const geoRef = useRef<{ cols?: number; rows?: number }>({ cols, rows })
  // Latest ownership, read inside the mount effect to pick driver vs viewer.
  const ownerRef = useRef<'desktop' | 'web'>(owner)
  // Lets the geometry-follow effect poke the mount effect's apply fn on prop change.
  const applyGeometryRef = useRef<(() => void) | null>(null)
  // Same, for the header tap: lets it re-send an ownership claim on demand.
  const sendClaimRef = useRef<(() => void) | null>(null)
  // Whether the user is reading the live bottom of the buffer (as opposed to
  // having scrolled back through the scrollback). Drives the re-pin after a
  // geometry change — see pinBottom in the mount effect.
  const followBottomRef = useRef(true)

  // The gesture state is synchronous so a second finger sees a held modifier
  // even before React commits the button's visual state.
  const [mods, setMods] = useState<Modifiers>(NO_MODS)
  const [modifierKeys] = useState(() => createModifierKeys(setMods))

  useEffect(() => {
    modifierKeys.reset()
    const onHidden = () => { if (document.hidden) modifierKeys.reset() }
    window.addEventListener('blur', modifierKeys.reset)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      modifierKeys.reset()
      window.removeEventListener('blur', modifierKeys.reset)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [modifierKeys, sessionId, controller])

  const {
    isDictating,
    isProcessing: isDictationProcessing,
    error: dictationError,
    start: onDictateStart,
    stop: onDictateStop,
    cancel: cancelDictation,
  } = useDictation(sessionId, undefined, () => connectionRef.current?.inputLease)

  useEffect(() => {
    if (!controller && (isDictating || isDictationProcessing)) cancelDictation()
  }, [controller, isDictating, isDictationProcessing, cancelDictation])

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

  const write = useCallback((data: string) => {
    if (!data) return
    if (!connectionRef.current?.input(data)) setInputError('Activate this view to control the terminal.')
  }, [])

  const onSpecial = useCallback(
    (key: string) => {
      write(specialKeyBytes(key, modifierKeys.current()))
      modifierKeys.consume()
    },
    [write, modifierKeys],
  )

  // Mount xterm + attach lifecycle.
  useEffect(() => {
    let term = new Terminal({
      convertEol: false,
      allowProposedApi: true,
      fontSize: TERMINAL_FONT_SIZE,
      fontFamily: TERMINAL_FONT,
      cursorBlink: true,
      scrollback: 10000,
      smoothScrollDuration: 0,
      // The mirror's hidden textarea is never focused (input is relayed from
      // the key bar / soft keyboard, and touch handlers don't focus
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
    let fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(hostRef.current!)
    termRef.current = term
    let screenEl = term.element?.querySelector<HTMLElement>('.xterm-screen')
    let renderedRowHeight = 0

    // Renderer. The default DOM renderer paints every cell as its own
    // inline-block box, and a phone's cell size is fractional (CSS px are a
    // third of a device px at dpr 3) — so the browser rounds each box's paint
    // rect independently and leaves hairline gaps between neighbours. In text
    // that's invisible; in the block glyphs TUIs draw art with it is a grid of
    // dark seams cutting through the picture (Claude's pet arrives quartered by
    // one horizontal and two vertical lines), and it dots the input box's rules.
    // The WebGL renderer draws box/block characters as exact device-pixel
    // rectangles instead of font glyphs, so they tile seamlessly. It is strictly
    // an optimisation of *how* the same buffer is painted: if WebGL2 is missing
    // or the context is lost (iOS drops it on a long-backgrounded tab) we drop
    // back to the DOM renderer and everything still works, just seamed again.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // no WebGL2 — the DOM renderer stays
    }

    // Terminal traffic rides the stream connection, not the command channel:
    // only `write` has a counterpart there, and the rest (attach, resize,
    // claim) are the connection's own protocol.
    const send = (kind: string, payload: unknown) => {
      if (kind === 'write') write((payload as { data: string }).data)
    }

    // The phone has two roles over the single shared PTY (see remote-bridge
    // geometry ownership):
    //  - DRIVER (owner 'web'): a focused phone owns the PTY size. It asks for its
    //    viewport's cols×rows with `claimGeometry`, the bridge resizes every PTY
    //    to it, and the content reflows to the phone width instead of being shrunk
    //    to microscopic.
    //  - VIEWER (owner 'desktop'): the desktop drives the size; the phone asks for
    //    nothing and shows the desktop's grid scaled down.
    //
    // What it does NOT do in either role is size its own grid. The mirror renders
    // exactly the (cols,rows) the bridge reports for the PTY, always, and scales
    // the pixels to fit — see lib/terminal-geometry.ts for why that invariant is
    // the whole ballgame. In driver mode the granted size is the size we asked
    // for, so the scale is 1 and nothing is resampled; the two roles differ only
    // in whether we claim, not in how we render.
    let disposed = false
    let fontReady = false
    // Already sized to this phone: scrolling or tapping while we own the grid
    // must not churn re-seeds by re-claiming what we already hold.
    const isDriver = () => Boolean(connectionRef.current?.isController)

    // While measuring, the host is stretched over the whole letterbox so FitAddon
    // reads the space actually available; the rest of the time it shrink-wraps the
    // grid so the scaler can size the terminal as one box.
    const setMeasureStyles = () => {
      const s = scaleRef.current
      const h = hostRef.current
      if (s) { s.style.inset = '0'; s.style.transform = 'none'; s.style.transformOrigin = 'top left' }
      if (h) { h.style.width = '100%'; h.style.height = '100%' }
    }
    const setRenderStyles = () => {
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
    const handleScroll = () => {
      if (disposed || writerRef.current?.isReplaying) return
      const b = term.buffer.active
      // Arriving at the bottom always means "follow the live output" again.
      if (b.viewportY >= b.baseY) {
        followBottomRef.current = true
        setFollowing(true)
        return
      }
      if (Date.now() >= userScrollUntil) return
      followBottomRef.current = false
      setFollowing(false)
      markUserScroll() // momentum keeps scrolling after the finger is gone
    }
    let onScroll = term.onScroll(handleScroll)

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
      const scale = fitScale(
        { width: xtermEl.offsetWidth, height: xtermEl.offsetHeight },
        { width: viewport.clientWidth, height: viewport.clientHeight },
      )
      scaleEl.style.transform = scale === 1 ? 'none' : `scale(${scale})`
      // Geometry already measures layout here. Cache the rendered cell size so
      // each finger/momentum frame can scroll without forcing another layout.
      renderedRowHeight = (screenEl?.getBoundingClientRect().height ?? 0) / term.rows
    }

    // xterm measures the glyph cell once and caches it, so a terminal opened
    // before the Nerd Font decoded keeps the *fallback* font's metrics forever —
    // and every cols×rows computed from them is wrong, which is how the phone ends
    // up claiming a grid it doesn't actually render at. Re-assigning fontFamily
    // does not help (OptionsService drops writes that don't change the value), so
    // force the remeasure directly. Same cure, and the same load-bearing hack, as
    // the desktop's attachTerminalAutoFit.
    const remeasureCell = () => {
      try {
        ;(term as unknown as { _core?: { _charSizeService?: { measure(): void } } })._core?._charSizeService?.measure()
      } catch {
        // internals moved — fit falls back to whatever xterm last measured
      }
    }

    // What the phone's viewport could show at 1:1, WITHOUT resizing xterm:
    // proposeDimensions only measures. Resizing here would be the mismatch this
    // component exists to avoid — the grid changes only when the bridge says so.
    const proposeGeometry = (): Geometry | null => {
      const scaleEl = scaleRef.current
      const host = hostRef.current
      if (disposed || !scaleEl || !host) return null
      const savedScale = scaleEl.style.cssText
      const savedHost = host.style.cssText
      setMeasureStyles()
      let dims: { cols?: number; rows?: number } | undefined
      try {
        dims = fitAddon.proposeDimensions()
      } catch {
        // renderer may be mid-frame
      }
      scaleEl.style.cssText = savedScale
      host.style.cssText = savedHost
      const proposed = { cols: dims?.cols ?? 0, rows: dims?.rows ?? 0 }
      return isSaneGeometry(proposed) ? proposed : null
    }

    // Ask the bridge to size the shared PTY to this phone. Called from the same
    // places as before (first render, focus/foreground, a tap on the terminal, a
    // tap on the worktree in the header, a viewport resize while we drive).
    const sendClaim = () => {
      if (disposed || document.visibilityState !== 'visible') return
      connectionRef.current?.setActive(true)
      connectionRef.current?.claim()
      const geometry = proposeGeometry()
      if (geometry) connectionRef.current?.resize(geometry.cols, geometry.rows)
    }

    // Render at the grid the stream is delivering. The connection owns the
    // authoritative size (it negotiated the resize), so there is nothing to
    // reconcile here — only the scale that fits it into this viewport.
    const applyGeometry = () => {
      if (disposed) return
      setRenderStyles()
      rescale()
      // A geometry change moves xterm's scroller under it — loudest when the
      // soft keyboard shrinks the shell by most of a screen. See pinBottom.
      pinBottom()
    }

    const markFontReady = (fontSettled: boolean) => {
      if (disposed) return
      if (fontReady) {
        // The fallback timer started us and the webfont has only now decoded: the
        // cell size changed under us, so every measurement since is stale. Take it
        // again and ask for a grid that matches what we now actually draw.
        if (fontSettled) {
          remeasureCell()
          sendClaim()
        }
        return
      }
      fontReady = true
      // The real font is in: everything measured against the fallback is stale.
      remeasureCell()
      applyGeometry()
      // Stake an ownership claim as the active viewer on first render, so the
      // bridge resizes the PTY to this viewport before seeding.
      sendClaim()
    }
    // Pull the Nerd Font, then attach. Fall back to a short timeout so a slow
    // connection never leaves the terminal blank waiting on the font.
    void document.fonts
      ?.load(`${TERMINAL_FONT_SIZE}px "JetBrainsMono Nerd Font Mono"`)
      .then(() => markFontReady(true))
      .catch(() => markFontReady(true))
    const fontTimer = setTimeout(() => markFontReady(false), 1200)

    // Defer the first geometry apply a frame: term.open() inits the renderer
    // asynchronously and the flex layout needs a beat to settle.
    const raf = requestAnimationFrame(applyGeometry)
    // Expose the scaler so the geometry-follow effect can re-apply on prop change.
    applyGeometryRef.current = applyGeometry
    // …and the claim, so a header tap can take the size back from the desktop.
    sendClaimRef.current = sendClaim

    // Re-claim ownership whenever the phone becomes the active viewer (tab focus
    // or foreground). The bridge grants it, resizes every PTY to this viewport,
    // and mirrors owner='web' back — which flips us into driver render mode.
    const stopLifecycle = subscribeTerminalLifecycle(() => connectionRef.current, sendClaim)

    const handleData = (data: string) => {
      send('write', { data: inputBytes(data, modifierKeys.current()) })
      modifierKeys.consume()
    }
    const bindInput = () => bindTerminalInput(term, { user: handleData })
    let unbindInput = bindInput()

    // Mirror xterm's selection into React so the floating Copy button appears
    // exactly while a long-press selection is live.
    const handleSelection = () => setHasSelection(term.hasSelection())
    let onSel = term.onSelectionChange(handleSelection)

    // Tell the browser which buffer we're on, so the CSS can hand it the right
    // gesture contract (see globals.css). The normal buffer has real scrollback
    // and wants Safari's native, compositor-driven pan; the alternate buffer has
    // none, and every touch there is ours to translate — so the browser should
    // not spend a frame deciding whether to scroll something that cannot scroll.
    const markBuffer = (type: string) => {
      term.element?.setAttribute('data-buffer', type === 'alternate' ? 'alt' : 'normal')
      // A buffer swap throws away whichever position we were reporting: the alt
      // screen is gone or brand new, and xterm is back at its own bottom.
      altBackRef.current = 0
      setAltScrolledBack(false)
    }
    markBuffer(term.buffer.active.type)
    const handleBuffer = (buf: { type: string }) => markBuffer(buf.type)
    let onBuffer = term.buffer.onBufferChange(handleBuffer)

    // Own single-finger gestures on both buffers. Local history scrolls at
    // display refresh rate; alternate-screen gestures remain bounded PTY input.
    const scroller = createTerminalScroller({
      metrics: () => ({
        rowHeight: renderedRowHeight,
        viewportY: term.buffer.active.viewportY,
        baseY: term.buffer.active.baseY,
      }),
      scrollLines: (lines) => { markUserScroll(); term.scrollLines(lines) },
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (id) => cancelAnimationFrame(id),
    })
    stopScrollRef.current = scroller.stop
    const writer = createTerminalWriter(term, {
      onBeforeReset: scroller.stop,
      onAfterWrite: () => {
        if (disposed) return
        if (followBottomRef.current) term.scrollToBottom()
      },
      onOverflow: () => {
        if (disposed) return
        // The writer outran its buffer; ask the stream for a fresh snapshot
        // rather than leaving a half-applied screen on display.
        connectionRef.current?.resume()
      },
    })
    writerRef.current = writer
    followBottomRef.current = true
    setFollowing(true)

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

    const altScrollBytes = (notches: number) =>
      altScrollSequence(
        {
          mouseTracking: term.modes.mouseTrackingMode !== 'none',
          applicationCursor: term.modes.applicationCursorKeysMode,
        },
        notches > 0,
      ).repeat(Math.abs(notches))
    const altScroll = createAltScrollQueue(notches => {
      if (disposed) return
      // One mutation carrying the whole pool: the TUI reads N wheel reports back
      // to back and repaints once, instead of N times over N round trips.
      send('write', { data: altScrollBytes(notches) })
      // Track where those notches left the program. Counting what actually goes
      // out (not what the gesture asked for) keeps the tally honest across the
      // pool's reversals and clamping.
      altBackRef.current = Math.max(0, altBackRef.current + notches)
      setAltScrolledBack(altBackRef.current > 0)
    })

    // Jump to the live end. On the normal buffer that is xterm's own scrollback.
    // On the alt screen it is one burst of wheel-down reports undoing the notches
    // we sent, plus slack for transcript the program grew while the reader was up
    // in its history — overshoot is free, since a TUI clamps at its live end.
    const jumpToLatest = () => {
      if (disposed) return
      stopScrollRef.current?.()
      if (term.buffer.active.type === 'alternate') {
        const back = altBackRef.current
        altBackRef.current = 0
        setAltScrolledBack(false)
        altScroll.start() // drop anything pooled; this jump supersedes it
        const count = jumpNotches(back, {
          mouseTracking: term.modes.mouseTrackingMode !== 'none',
          slack: ALT_JUMP_SLACK_NOTCHES,
          max: ALT_JUMP_MAX_NOTCHES,
        })
        if (count > 0) send('write', { data: altScrollBytes(-count) })
        return
      }
      followBottomRef.current = true
      setFollowing(true)
      term.scrollToBottom()
    }
    jumpLatestRef.current = jumpToLatest

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
      scroller.stop()
      altScroll.start()
      if (e.touches.length !== 1) {
        selecting = false
        touchY = null
        cancelLongPress()
        return
      }
      touchY = e.touches[0].clientY
      altGesture = term.buffer.active.type === 'alternate'
      if (!altGesture) scroller.start(touchY, performance.now())
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
        scroller.stop()
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
      e.preventDefault()
      e.stopImmediatePropagation()
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
      if (touchY === null) return
      if (!altGesture) {
        scroller.move(e.touches[0].clientY, performance.now())
        return
      }
      // Own the gesture for its whole life, not just the moves that happen to
      // complete a notch. Leaving the sub-notch moves to Safari lets its pan
      // machinery start arbitrating a scroll it will never perform (the alt
      // screen has no scrollback to pan), and the hitch that produces is felt at
      // the start of every swipe — the part where a scroll either bites or doesn't.
      e.preventDefault()
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
      // Finger moving down (notches > 0) reveals earlier content → scroll up.
      if (notches !== 0) altScroll.push(notches)
    }
    const onTouchEnd = (e: TouchEvent) => {
      cancelLongPress()
      if (e.type === 'touchcancel' || selecting || e.touches.length > 0) scroller.stop()
      else if (!altGesture) scroller.end(performance.now())
      // Whatever the last moves earned goes out now: the gesture is over, so
      // there is nothing left to coalesce it with and holding it only adds delay.
      if (e.type === 'touchcancel') altScroll.start()
      else altScroll.flush()
      touchY = null
      altGesture = false
      scrollAccum = 0
      selecting = false
      anchor = null // end the drag but keep the selection for the Copy button
    }
    const termEl = hostRef.current
    // touchmove must be non-passive so preventDefault() can suppress the browser
    // pan on the alt screen.
    const onPointerActivate = () => { if (!isDriver()) sendClaim() }
    termEl?.addEventListener('pointerdown', onPointerActivate)
    termEl?.addEventListener('touchstart', onTouchStart, { passive: true })
    termEl?.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
    termEl?.addEventListener('touchend', onTouchEnd, { passive: true })
    termEl?.addEventListener('touchcancel', onTouchEnd, { passive: true })
    // The mirror is usable from a desktop browser too, where scrollback is a wheel.
    termEl?.addEventListener('wheel', markUserScroll, { passive: true })

    // A ResizeObserver (not window 'resize') is required: window 'resize' does not
    // fire when the flex siblings (key bar + action bar) mount/measure or when the
    // mobile URL bar shows/hides — which is exactly when our viewport changes.
    // Debounced to avoid a burst during layout/animation. In viewer mode we only
    // re-fit the scale; in driver mode a real viewport change means the PTY should
    // resize, so we re-claim (and adopt whatever comes back).
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
        applyGeometry()
        const geometry = proposeGeometry()
        if (geometry) connectionRef.current?.resize(geometry.cols, geometry.rows)
      }, 0)
    })
    ro.observe(viewportRef.current!)

    // Recovery parses into a second, bounded terminal. Keep the visible xterm
    // intact until the checkpoint callback, then rebind its existing controls.
    const applier = new TerminalApplier({
      onHistoryExpired: () => setHistoryExpired(true),
      current: () => term,
      stage: () => {
        const next = new Terminal({ ...term.options, scrollback: 10000 })
        const container = document.createElement('div')
        container.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden'
        hostRef.current!.appendChild(container)
        const nextFit = new FitAddon()
        next.loadAddon(nextFit)
        next.open(container)
        return {
          terminal: next,
          dispose: () => { next.dispose(); container.remove() },
          commit: () => {
            scroller.stop()
            unbindInput(); onSel.dispose(); onBuffer.dispose(); onScroll.dispose()
            const previous = term
            term = next; fitAddon = nextFit; termRef.current = next
            previous.dispose()
            hostRef.current!.replaceChildren(container)
            container.style.cssText = 'width:100%;height:100%'
            screenEl = term.element?.querySelector<HTMLElement>('.xterm-screen')
            try {
              const webgl = new WebglAddon()
              webgl.onContextLoss(() => webgl.dispose())
              term.loadAddon(webgl)
            } catch { /* DOM renderer remains available. */ }
            unbindInput = bindInput()
            onSel = term.onSelectionChange(handleSelection)
            onBuffer = term.buffer.onBufferChange(handleBuffer)
            onScroll = term.onScroll(handleScroll)
            markBuffer(term.buffer.active.type)
            followBottomRef.current = term.buffer.active.viewportY >= term.buffer.active.baseY
            setFollowing(followBottomRef.current)
            setHasSelection(false)
            remeasureCell()
            applyGeometry()
          },
        }
      },
    })
    const connection = new TerminalConnection({ sessionId, applier,
      onStatus: setStreamStatus,
      onController: setController,
      onUnsupported: () => setUnsupported(true),
      onHistoryExpired: () => setHistoryExpired(true),
      onApplied: () => { applyGeometry(); setInputError(null) },
    })
    connectionRef.current = connection
    connection.setActive(document.visibilityState === 'visible')
    connection.start()

    return () => {
      disposed = true
      connectionRef.current?.dispose()
      connectionRef.current = null
      applier.dispose()
      scroller.stop()
      writer.dispose()
      writerRef.current = null
      stopScrollRef.current = null
      applyGeometryRef.current = null
      sendClaimRef.current = null
      cancelLongPress()
      altScroll.dispose()
      unbindInput()
      onSel.dispose()
      onBuffer.dispose()
      onScroll.dispose()
      letterbox.removeEventListener('scroll', onLetterboxScroll)
      stopLifecycle()
      termEl?.removeEventListener('pointerdown', onPointerActivate)
      termEl?.removeEventListener('touchstart', onTouchStart)
      termEl?.removeEventListener('touchmove', onTouchMove, true)
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

  // Header tap (or picking the phone up — see useMotionClaim, which bumps this
  // same nonce): take the shared PTY back from the desktop and reflow it to this
  // phone. The desktop reclaims on any click or mouse movement over there, so
  // the phone needs its own way to say "no, me". Both triggers are things you
  // can only do while holding the device with the page in the foreground, which
  // is what keeps a pocketed PWA waking up from firing one by accident.
  // The seen-nonce ref is initialized to the mounting value so a remount (new
  // session, foreground resync) doesn't replay an old tap as a claim — the mount
  // effect stakes its own first claim once the font has loaded.
  const seenClaimNonce = useRef(claimNonce)
  useEffect(() => {
    if (claimNonce === seenClaimNonce.current) return
    seenClaimNonce.current = claimNonce
    sendClaimRef.current?.()
  }, [claimNonce])

  // Recolor xterm when the active workspace color changes (navigating between
  // workspaces), matching the desktop's [termBg] theme-update effect. Also repaint
  // the letterbox viewport (visible around the scaled terminal in viewer mode) so
  // the padding matches the terminal background instead of a hardcoded black.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(color)
    if (viewportRef.current) viewportRef.current.style.backgroundColor = terminalBg(color)
  }, [color])

  return (
    <div className="flex h-full flex-col">
      {/* Viewport clips the scaled terminal; the scaler shrinks the desktop-width
          xterm to fit without resizing the shared PTY. select-none + no touch
          callout so a long-press starts our drag-selection, not the OS text menu. */}
      <div
        ref={viewportRef}
        className="terminal-surface relative min-h-0 flex-1 select-none overflow-hidden"
        style={{ WebkitTouchCallout: 'none', backgroundColor: terminalBg(color) }}
      >
        {/* Contain xterm's canvas/input z-indexes even at scale 1 (no transform),
            so they cannot intercept taps on the sibling overlay controls. */}
        <div ref={scaleRef} className="absolute left-0 top-0 z-0 origin-top-left">
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
        {/* Jump to the live end, on either buffer. A full-screen TUI paints its
            own version of this hint, but that one is only pixels in a terminal:
            tapping it lands on xterm, which on Android re-summons the IME for the
            still-focused helper textarea — the tap answers with a keyboard instead
            of a scroll. This button sits outside term.element (no touch handler
            sees it) and lets go of a hidden keyboard before acting. */}
        {(!following || altScrolledBack) && (
          <button
            type="button"
            // Keep an open keyboard open (mousedown), but let go of one that is
            // already hidden (pointerdown) — the key bar's keys do the same.
            onPointerDown={() => releaseHiddenKeyboardFocus()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => jumpLatestRef.current?.()}
            className="absolute bottom-3 right-3 z-10 flex min-h-11 items-center gap-1.5 rounded-full border border-white/20 bg-black/80 px-4 text-sm text-white shadow-lg"
          >
            <ArrowDown className="size-4" /> Latest
          </button>
        )}

      </div>
      {unsupported && <div role="alert" className="bg-red-950 px-3 py-2 text-xs text-red-100">This session can&apos;t be streamed. Reopen Orchestra on your computer to reconnect.</div>}
      {!unsupported && (streamStatus || !controller) && <div role="status" className="bg-sidebar px-3 py-1 text-xs text-muted-foreground">{streamStatus || 'Viewing — activate this terminal to take control.'}</div>}
      {historyExpired && <div role="status" className="bg-amber-950 px-3 py-2 text-xs text-amber-100">Earlier terminal history expired. Showing the retained history.</div>}
      {inputError && <div role="alert" className="bg-red-950 px-3 py-2 text-xs text-red-100">{inputError}</div>}
      <fieldset disabled={!controller} className="min-w-0 border-0 p-0 m-0">
      <AgentKeyBar
        sessionId={sessionId}
        getInputLease={() => connectionRef.current?.inputLease}
        canSend={() => connectionRef.current?.isController ?? false}
        onPaste={(data) => connectionRef.current?.input(data) ?? false}
        mods={mods}
        onToggleMod={modifierKeys.toggle}
        onModDown={modifierKeys.press}
        onModUp={modifierKeys.release}
        onSpecial={onSpecial}
        isDictating={isDictating}
        isDictationProcessing={isDictationProcessing}
        onDictateStart={onDictateStart}
        onDictateStop={onDictateStop}
      />
      </fieldset>
      <UsageStrip onResumed={onActionFired} />
    </div>
  )
}
