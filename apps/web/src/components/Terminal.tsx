'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Check, Copy, X } from 'lucide-react'
import { nextChunks, type Chunk } from '../lib/chunk-buffer'
import { shouldReanchor } from '../lib/mirror-stall'
import {
  anyModifier,
  charBytes,
  NO_MODS,
  specialKeyBytes,
  type Modifiers,
} from '../lib/keyboard'
import { AgentKeyBar } from './AgentKeyBar'
import { ActionBar } from './ActionBar'
import { UsageStrip } from './UsageStrip'
import { useDictation } from '../hooks/useDictation'
import { altScrollSequence } from '../lib/terminal-scroll'
import { terminalBg, terminalTheme } from '../lib/terminal-theme'
import {
  chooseGeometry,
  claimSettled,
  fitScale,
  isSaneGeometry,
  sameGeometry,
  type Geometry,
} from '../lib/terminal-geometry'
import '@xterm/xterm/css/xterm.css'

// Match the desktop terminal so Nerd Font glyphs (powerline, git, devicons)
// render instead of tofu boxes. The family is @font-face'd in globals.css.
const TERMINAL_FONT = '"JetBrainsMono Nerd Font Mono", Menlo, Monaco, "Courier New", monospace'
const TERMINAL_FONT_SIZE = 13

// Pixels of vertical swipe per emitted scroll notch on the alt screen. Tuned so a
// finger drag scrolls a full-screen TUI at a comfortable rate (smaller = faster).
const ALT_SCROLL_STEP_PX = 18

// How long to wait after the grid changes size before asking the bridge for a
// fresh frame at that size. Long enough that a soft keyboard's animation (a burst
// of resizes) costs one re-seed, short enough not to sit on a stale screen.
const RESEED_DEBOUNCE_MS = 300

// How long a geometry claim may stand in for the bridge's answer before we go
// back to rendering whatever size the bridge actually reports.
const CLAIM_GRANT_TIMEOUT_MS = 4000

// How often the stall watchdog looks for an unanswered keystroke. Well under the
// silence window it enforces, so a real stall is caught within a second of it.
const STALL_TICK_MS = 1000

export function TerminalPane({
  token,
  sessionId,
  cols,
  rows,
  owner,
  color,
  claimNonce,
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
  /**
   * Bumped when the user taps the worktree name in the header — the phone's
   * explicit "size this session to me". Each new value re-sends a geometry
   * claim; the value itself carries no meaning.
   */
  claimNonce: number
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
  // Same, for the header tap: lets it re-send an ownership claim on demand.
  const sendClaimRef = useRef<(() => void) | null>(null)
  const [afterSeq, setAfterSeq] = useState(-1)
  // Set once any chunk has been written, so the attach watchdog knows the stream
  // is live and stops re-firing `attach`.
  const firstChunkRef = useRef(false)
  // Stall detection (see lib/mirror-stall): a keystroke that never gets echoed
  // means the chunk subscription is wedged, and nothing else recovers a stall that
  // happens while the app stays in the foreground.
  const lastInputAtRef = useRef(0)
  const lastChunkAtRef = useRef(0)
  const lastReanchorAtRef = useRef(0)
  // Lets the stall watchdog re-fire `attach` from outside the mount effect.
  const sendAttachRef = useRef<(() => void) | null>(null)
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
      if (!data) return
      lastInputAtRef.current = Date.now()
      void convex.mutation(anyApi.remote.sendCommand, { token, sessionId, kind: 'write', payload: { data } })
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

    const send = (kind: string, payload: unknown) => {
      // A write is the one command the PTY owes an answer to (it echoes), so it's
      // what arms the stall watchdog below.
      if (kind === 'write') lastInputAtRef.current = Date.now()
      void convex.mutation(anyApi.remote.sendCommand, { token, sessionId, kind, payload })
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
    let attached = false
    let fontReady = false
    // Geometry we asked for and the bridge has not answered yet. It outranks the
    // mirrored value until then (see chooseGeometry) — the bridge grants claims
    // verbatim and re-seeds at the granted size, and that seed can overtake the
    // geometry echo on its way to us.
    let pendingClaim: Geometry | null = null
    let claimTimer: ReturnType<typeof setTimeout> | null = null
    // Geometry the last `attach` was sent at, so a real size change can ask for a
    // fresh seed — the screen we're holding was painted for the old grid.
    let attachedAt: Geometry | null = null
    let reseedTimer: ReturnType<typeof setTimeout> | null = null
    const isDriver = () => ownerRef.current === 'web'

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
      const scale = fitScale(
        { width: xtermEl.offsetWidth, height: xtermEl.offsetHeight },
        { width: viewport.clientWidth, height: viewport.clientHeight },
      )
      scaleEl.style.transform = scale === 1 ? 'none' : `scale(${scale})`
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
      remeasureCell()
      const claim = proposeGeometry()
      if (!claim) return
      pendingClaim = claim
      if (claimTimer) clearTimeout(claimTimer)
      // A claim the bridge never answers — the desktop reclaimed the size a beat
      // later, the mirror is offline — must not leave us rendering a grid the PTY
      // doesn't have. Give it a couple of round-trips, then defer to the bridge.
      claimTimer = setTimeout(() => {
        claimTimer = null
        if (disposed || !pendingClaim) return
        pendingClaim = null
        applyGeometry()
      }, CLAIM_GRANT_TIMEOUT_MS)
      applyGeometry()
      send('claimGeometry', claim)
    }

    // Render at the authoritative grid: the size we just claimed if the bridge
    // hasn't answered, else the PTY size it reports, else — only before the mirror
    // has ever spoken — what our own viewport can show.
    const applyGeometry = () => {
      if (disposed) return
      setRenderStyles()
      const reported = { cols: geoRef.current.cols ?? 0, rows: geoRef.current.rows ?? 0 }
      const mirrored = isSaneGeometry(reported) ? reported : null
      if (claimSettled(pendingClaim, mirrored)) pendingClaim = null
      const target = chooseGeometry(mirrored, pendingClaim) ?? proposeGeometry()
      if (target && (term.cols !== target.cols || term.rows !== target.rows)) {
        const ownClaim = sameGeometry(target, pendingClaim)
        try {
          term.resize(target.cols, target.rows)
        } catch {
          // ignore — renderer may be mid-frame
        }
        // The frame on screen was painted for the old grid, and a TUI that is just
        // sitting idle will not repaint it — so ask for a fresh one, debounced so a
        // keyboard animation's worth of resizes costs a single re-seed. Not needed
        // when we're following our own claim: granting one re-seeds at the bridge.
        if (!ownClaim) scheduleReseed()
      }
      rescale()
      pinBottom()
    }

    // (Re)attach at the current grid. The bridge reflows the PTY, snapshots it and
    // sends the frame back flagged as a seed, which resets xterm before replaying.
    const sendAttach = () => {
      if (disposed) return
      attachedAt = { cols: term.cols, rows: term.rows }
      send('attach', attachedAt)
    }
    const scheduleReseed = () => {
      if (disposed || !attached) return
      if (reseedTimer) clearTimeout(reseedTimer)
      reseedTimer = setTimeout(() => {
        reseedTimer = null
        if (disposed || sameGeometry(attachedAt, { cols: term.cols, rows: term.rows })) return
        sendAttach()
      }, RESEED_DEBOUNCE_MS)
    }

    const maybeAttach = () => {
      if (disposed || attached || !fontReady) return
      // Size to the authoritative grid before seeding so the seed (serialized at
      // that geometry) replays into a matching client.
      applyGeometry()
      attached = true
      sendAttach()
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
      // Stake an ownership claim as the active viewer on first render, before
      // attaching, so the bridge resizes the PTY to this viewport before seeding.
      sendClaim()
      maybeAttach()
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
    // …and the attach, so the stall watchdog can ask for a fresh seed.
    sendAttachRef.current = sendAttach

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
      sendAttach()
    }, 2500)

    return () => {
      disposed = true
      applyGeometryRef.current = null
      sendClaimRef.current = null
      sendAttachRef.current = null
      clearInterval(attachWatchdog)
      if (reseedTimer) clearTimeout(reseedTimer)
      if (claimTimer) clearTimeout(claimTimer)
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

  // Stream chunks → xterm.
  const chunks = useQuery(anyApi.remote.getChunks, { token, sessionId, afterSeq }) as Chunk[] | undefined
  useEffect(() => {
    if (!chunks || chunks.length === 0 || !termRef.current) return
    const term = termRef.current
    const { data, afterSeq: next, reset } = nextChunks(chunks, afterSeq)
    // Proof of life for the stall watchdog below — recorded for any batch that
    // reached us, including one the cursor has already consumed.
    lastChunkAtRef.current = Date.now()
    // Follow the live output while the user is at the bottom. xterm does this
    // itself, but only while its scroller agrees it's at the bottom — a resize
    // (soft keyboard) can leave the two out of step, and then the stream would
    // silently render below the fold. See pinBottom in the mount effect.
    const afterWrite = () => {
      if (followBottomRef.current) termRef.current?.scrollToBottom()
    }
    // A seed chunk is a full-screen repaint: clear xterm first so a re-seed
    // (second viewer, desktop wake re-seed, respawn) repaints cleanly instead
    // of layering onto stale content.
    // A seed wipes the buffer the user was reading, so whatever scrollback
    // position they held is gone with it — start following the bottom again.
    if (reset) {
      followBottomRef.current = true
      // reset() runs NOW, but xterm parses write()s from a queue — so calling it
      // outright jumps ahead of any bytes still queued from an earlier batch.
      // Those then paint onto the freshly cleared screen and the seed lands on
      // top of them: ghost rows in the scrollback that nothing erases. Ordering
      // it behind an empty write puts the clear back in its place in the stream.
      term.write('', () => {
        termRef.current?.reset()
        if (data) termRef.current?.write(data, afterWrite)
      })
      firstChunkRef.current = true
    } else if (data) {
      term.write(data, afterWrite)
      firstChunkRef.current = true // tells the attach watchdog the stream is live
    }
    if (next !== afterSeq) setAfterSeq(next)
  }, [chunks, afterSeq])

  // Stall watchdog: recover a chunk stream that went deaf while the app stayed in
  // the foreground. See lib/mirror-stall for why a keystroke with no echo is the
  // signal, and why nothing else catches this — the attach watchdog retires after
  // the first chunk, and the foreground re-anchor needs a visibilitychange that
  // never comes to an app you're looking at.
  //
  // Recovery is exactly what a remount does, minus the remount: drop the cursor
  // back to -1 (a brand-new subscription, at args that can't be the wedged ones)
  // and re-attach, so the bridge re-seeds above every cursor and xterm repaints.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!termRef.current) return
      const now = Date.now()
      if (
        !shouldReanchor(now, {
          lastInputAt: lastInputAtRef.current,
          lastChunkAt: lastChunkAtRef.current,
          lastReanchorAt: lastReanchorAtRef.current,
          visible: document.visibilityState === 'visible',
          connected: convex.connectionState().isWebSocketConnected,
        })
      )
        return
      lastReanchorAtRef.current = now
      // Count the re-anchor itself as activity, so a bridge that is genuinely gone
      // costs one re-seed per cooldown rather than one per tick.
      lastChunkAtRef.current = now
      firstChunkRef.current = false
      setAfterSeq(-1)
      sendAttachRef.current?.()
    }, STALL_TICK_MS)
    return () => clearInterval(timer)
  }, [convex])

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
      <UsageStrip token={token} onResumed={onActionFired} />
    </div>
  )
}
