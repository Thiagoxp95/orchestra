import type { Terminal } from 'xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { isSaneGeometry, type Geometry } from '../utils/terminal-geometry'

// xterm 5.3 exposes the char-measurement service on its private core. We poke it
// directly to FORCE a re-measure: xterm caches the cell size (`hasValidSize`) and
// `fitAddon.fit()` alone will NOT re-measure once a (wrong, fallback-font)
// measurement succeeded. Forcing the measure is the load-bearing part of the
// font-load-race fix — see useMaestroTerminal.ts which does the same thing.
type XtermWithCore = Terminal & {
  _core?: { _charSizeService?: { measure?: () => void } }
}

export type AutoFitReason =
  | 'initial'
  | 'observer'
  | 'fonts'
  | 'visibility'
  | 'focus'
  | 'dpr'
  | 'manual'

export interface AutoFitHandle {
  /** Force a remeasure + fit now; fires `onSize` if the fitted size is usable. */
  reconcile: (reason?: AutoFitReason) => void
  dispose: () => void
}

export interface AutoFitOptions {
  /**
   * Fires after every successful fit with the freshly-measured geometry. The
   * caller decides what to do (e.g. resize the PTY); de-duping is the caller's
   * job via `planPtyResize`. `healed` is false only for the very first
   * ('initial') fit.
   */
  onSize: (geometry: Geometry, ctx: { reason: AutoFitReason; healed: boolean }) => void
  /** Skip fitting while this returns true (e.g. maestro mode). Hidden/zero-size is detected automatically. */
  isPaused?: () => boolean
  /** Exact font families to wait for before/around the authoritative fit. */
  fontFamilies?: string[]
  /** Font size (px) used when requesting the specific font faces. */
  fontSizePx?: number
  /** ResizeObserver / window-resize debounce (ms). */
  debounceMs?: number
}

const DEFAULT_FONT_FAMILIES = ['"JetBrainsMono Nerd Font Mono"']
const DEFAULT_FONT_SIZE_PX = 14
const DEFAULT_DEBOUNCE_MS = 80
// Bounded per-frame retries for the very first fit, covering the window where
// the container is mounted but not yet laid out (0x0). The ResizeObserver also
// catches the 0 -> non-zero transition; this is belt-and-suspenders.
const MAX_INITIAL_RETRIES = 30

/**
 * Keep an already-opened xterm `Terminal` fitted to its container and self-heal
 * the well-known xterm sizing failure modes:
 *
 *  - font-load race: the custom mono font loads async after `term.open()`, so the
 *    first measurement uses the fallback font's (wrong) cell metrics. We force a
 *    re-measure once the specific faces load AND on `fonts.ready`/`loadingdone`.
 *  - cached bad metric: xterm won't re-measure on its own; we always force it.
 *  - hidden / background macOS Space: nothing refits when a window returns to the
 *    foreground, so we reconcile on `visibilitychange`, window `focus`, and DPR
 *    changes (monitor moves) in addition to the ResizeObserver.
 *  - zero-size open: a fit while the container is 0x0 is skipped (never propagated)
 *    and retried.
 *
 * Assumes `term.open(container)` has already been called.
 */
export function attachTerminalAutoFit(
  term: Terminal,
  fitAddon: FitAddon,
  container: HTMLElement,
  options: AutoFitOptions,
): AutoFitHandle {
  const {
    onSize,
    isPaused,
    fontFamilies = DEFAULT_FONT_FAMILIES,
    fontSizePx = DEFAULT_FONT_SIZE_PX,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = options

  let disposed = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const rafs = new Set<number>()
  const cleanups: Array<() => void> = []

  const doc = container.ownerDocument
  const win = doc.defaultView ?? window

  const isHidden = () =>
    container.clientWidth === 0 ||
    container.clientHeight === 0 ||
    container.getClientRects().length === 0

  /** Force a re-measure, fit, and return the resulting geometry if it is usable. */
  const measureAndFit = (): Geometry | null => {
    if (disposed) return null
    if (isPaused?.() || isHidden()) return null
    ;(term as XtermWithCore)._core?._charSizeService?.measure?.()
    try {
      fitAddon.fit()
    } catch {
      // xterm can throw from the renderer if the element was detached. Ignore.
      return null
    }
    const geo: Geometry = { cols: term.cols, rows: term.rows }
    return isSaneGeometry(geo) ? geo : null
  }

  const reconcile = (reason: AutoFitReason = 'manual') => {
    if (disposed) return
    const geo = measureAndFit()
    if (!geo) return
    onSize(geo, { reason, healed: reason !== 'initial' })
  }

  // --- initial fit (deferred + bounded retry until the container is laid out) ---
  const runInitial = (attempt: number) => {
    if (disposed) return
    const geo = measureAndFit()
    if (geo) {
      onSize(geo, { reason: 'initial', healed: false })
      return
    }
    if (attempt >= MAX_INITIAL_RETRIES) return
    const raf = win.requestAnimationFrame(() => {
      rafs.delete(raf)
      runInitial(attempt + 1)
    })
    rafs.add(raf)
  }
  // Two frames out: term.open() initializes the renderer asynchronously.
  const startRaf = win.requestAnimationFrame(() => {
    rafs.delete(startRaf)
    const second = win.requestAnimationFrame(() => {
      rafs.delete(second)
      runInitial(0)
    })
    rafs.add(second)
  })
  rafs.add(startRaf)

  // --- font-load heal: the load-bearing fix for the reported bug ---
  const fonts: FontFaceSet | undefined = doc.fonts
  if (fonts) {
    // Actively kick off loading the exact faces, then reconcile when each settles.
    for (const family of fontFamilies) {
      void fonts.load(`${fontSizePx}px ${family}`).then(() => reconcile('fonts')).catch(() => {})
    }
    // Whole-document readiness (covers faces we didn't enumerate, e.g. bold/italic).
    void fonts.ready.then(() => reconcile('fonts')).catch(() => {})
    // Late swaps (bold/italic decoded mid-session) also fire loadingdone.
    const onLoadingDone = () => reconcile('fonts')
    fonts.addEventListener?.('loadingdone', onLoadingDone)
    cleanups.push(() => fonts.removeEventListener?.('loadingdone', onLoadingDone))
  }

  // --- container resize (debounced) ---
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const debouncedReconcile = (reason: AutoFitReason) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      timers.delete(debounceTimer)
    }
    debounceTimer = setTimeout(() => {
      if (debounceTimer) timers.delete(debounceTimer)
      debounceTimer = null
      reconcile(reason)
    }, debounceMs)
    timers.add(debounceTimer)
  }

  const resizeObserver = new ResizeObserver(() => debouncedReconcile('observer'))
  resizeObserver.observe(container)
  cleanups.push(() => resizeObserver.disconnect())

  // --- foreground / focus / DPR reconcile (background-Space + monitor moves) ---
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') reconcile('visibility')
  }
  doc.addEventListener('visibilitychange', onVisibility)
  cleanups.push(() => doc.removeEventListener('visibilitychange', onVisibility))

  const onFocus = () => reconcile('focus')
  win.addEventListener('focus', onFocus)
  cleanups.push(() => win.removeEventListener('focus', onFocus))

  const onWinResize = () => debouncedReconcile('observer')
  win.addEventListener('resize', onWinResize)
  cleanups.push(() => win.removeEventListener('resize', onWinResize))

  // devicePixelRatio change (window dragged to a monitor with a different DPR).
  let dprMedia: MediaQueryList | null = null
  const onDprChange = () => {
    reconcile('dpr')
    listenDpr() // matchMedia(dppx) only fires once; re-arm for the next change.
  }
  const listenDpr = () => {
    if (typeof win.matchMedia !== 'function') return
    dprMedia?.removeEventListener?.('change', onDprChange)
    dprMedia = win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`)
    dprMedia.addEventListener?.('change', onDprChange)
  }
  listenDpr()
  cleanups.push(() => dprMedia?.removeEventListener?.('change', onDprChange))

  return {
    reconcile,
    dispose() {
      disposed = true
      for (const t of timers) clearTimeout(t)
      timers.clear()
      for (const r of rafs) win.cancelAnimationFrame(r)
      rafs.clear()
      for (const c of cleanups.splice(0)) {
        try {
          c()
        } catch {
          // best-effort teardown
        }
      }
    },
  }
}
