'use client'
import { useEffect } from 'react'

/**
 * Keeping the app shell inside the *visual* viewport — the part of the screen the
 * on-screen keyboard doesn't cover.
 *
 * The shell is sized to the screen (`h-svh`) with a non-scrolling body, which is
 * what stops a swipe over the terminal from panning the page. But `svh` is the
 * LAYOUT viewport, and on iOS the layout viewport does not shrink when the soft
 * keyboard opens — only the visual viewport does. So the bottom of the layout
 * (the terminal's input line, the key bar, the action bar) ends up behind the
 * keyboard: you tap the terminal to type and can no longer see what you type.
 *
 * Publishing the visual viewport as CSS variables lets the shell shrink to the
 * still-visible strip; the terminal's own ResizeObserver then re-fits (and, while
 * the phone drives geometry, re-claims the PTY size) so the TUI reflows its input
 * box to just above the keyboard.
 */

/** The bits of `window.visualViewport` this module reads. */
export interface VisualViewportBox {
  height: number
  offsetTop: number
  scale: number
}

export interface AppViewport {
  /** Height the shell should occupy, in CSS px. */
  height: number
  /** Where the shell should start, measured from the top of the layout viewport. */
  top: number
  /** True once the occluded strip is deep enough to be a soft keyboard. */
  keyboardOpen: boolean
}

/**
 * Anything smaller than this is browser chrome (URL bar, iOS accessory strip on
 * its own), not a keyboard — a keyboard is worth relayout, a toolbar isn't.
 */
export const KEYBOARD_MIN_INSET_PX = 120

/**
 * Where the app shell should sit inside the layout viewport, given the visual
 * viewport. Falls back to the full layout height whenever the visual viewport
 * can't be trusted (absent, zero-sized, or pinch-zoomed — a magnified view is a
 * smaller visual viewport over the *same* layout, and shrinking the shell for it
 * would fight the zoom).
 */
export function appViewport(
  layoutHeight: number,
  vv: VisualViewportBox | null | undefined,
  /**
   * The tallest layout viewport seen in this orientation. In an installed iOS
   * PWA `window.innerHeight` SHRINKS with the keyboard, so layoutHeight - vv
   * .height is ~0 while the keyboard is up and the occlusion test never fires
   * (symptom: the usage strip stayed on screen with the keyboard open, stealing
   * rows). Measuring against the tallest height instead survives that. Omitted
   * (first paint, tests): fall back to the layout height.
   */
  tallestLayoutHeight?: number,
): AppViewport {
  const full: AppViewport = { height: layoutHeight, top: 0, keyboardOpen: false }
  if (!vv || layoutHeight <= 0 || vv.height <= 0) return full
  if (vv.scale > 1.01) return full
  const height = Math.min(layoutHeight, Math.round(vv.height))
  const baseline = Math.max(layoutHeight, tallestLayoutHeight ?? 0)
  // Only a keyboard is worth shrinking for. A shallower inset is browser chrome
  // or — the case that cost a screenful — an installed iOS PWA whose visual
  // viewport comes back short by ~100px after the keyboard closes and never
  // fires another resize. Shrinking for that leaves the usage strip floating
  // above a dead band of background, so hand back the full layout height and let
  // the bottom bars sit on the bottom of the screen.
  if (baseline - height < KEYBOARD_MIN_INSET_PX) return full
  // iOS pans the visual viewport down over the layout viewport when it wants to
  // reveal a focused element the keyboard would cover (the page itself can't
  // scroll here). Offsetting the shell by the same amount keeps it exactly on the
  // visible strip instead of half off the top of the screen.
  const top = Math.max(0, Math.min(Math.round(vv.offsetTop), layoutHeight - height))
  return { height, top, keyboardOpen: true }
}

/**
 * Publish the visual viewport on `<html>` as `--app-h` / `--app-top`, the *layout*
 * viewport as `--app-full-h`, plus a `data-keyboard` flag, and keep them current
 * as the keyboard opens and closes. Mount once; the shell consumes the variables
 * (see page.tsx / globals.css).
 *
 * `--app-full-h` exists because `100svh` is not trustworthy in an installed iOS
 * PWA: it can come back short by roughly a browser toolbar's height even though
 * there is no toolbar, leaving a dead band of background under the bottom-most
 * bar. `window.innerHeight` measures the same layout viewport and is right. The
 * shell itself no longer uses it (both views take `--app-h` + `--app-top` — see
 * page.tsx), so it is left published for anything that wants the unshrunk height.
 *
 * `top` is applied as a margin rather than a transform on purpose: a transformed
 * ancestor would become the containing block for `position: fixed` descendants,
 * which the Linear ticket card relies on resolving against the viewport.
 */
export function useAppViewport(): void {
  useEffect(() => {
    const root = document.documentElement
    // Tallest layout viewport seen since the last rotation — the "no keyboard"
    // reference (see appViewport). Reset on orientationchange, where the real
    // full height changes and yesterday's maximum means nothing.
    let tallest = 0
    const apply = (): void => {
      tallest = Math.max(tallest, window.innerHeight)
      const vvBox = window.visualViewport
      const { height, top, keyboardOpen } = appViewport(window.innerHeight, vvBox, tallest)
      root.style.setProperty('--app-h', `${height}px`)
      root.style.setProperty('--app-top', `${top}px`)
      root.style.setProperty('--app-full-h', `${window.innerHeight}px`)
      // TEMPORARY (ViewportDebug): the baseline the keyboard gate compares
      // against. Remove with the debug overlay.
      root.style.setProperty('--app-tallest', `${tallest}px`)
      root.dataset.keyboard = keyboardOpen ? 'open' : 'closed'

      // Undo iOS's stuck pan. On focusing the composer iOS pans the visual
      // viewport to reveal the textarea at its PRE-shrink position; a frame
      // later we shrink the shell and the textarea is now well inside the
      // panned window — so iOS sees nothing to correct and never pans back.
      // offsetTop stays parked at ~half the screen, which is the "everything
      // jumped way up" symptom (the shell's bottom edge ends up under the
      // status bar with a screenful of background beneath it).
      //
      // Scrolling the layout viewport back to 0 is what actually clears it:
      // with the shell already shrunk to the visible strip, y=0 IS the correct
      // resting place and the composer sits just above the keyboard, so iOS has
      // no reason to pan again. Guarded on a non-zero offset so the reset can't
      // feed itself through the 'scroll' listener that calls this.
      if (keyboardOpen && vvBox && vvBox.offsetTop > 0) window.scrollTo(0, 0)
    }
    apply()
    const vv = window.visualViewport
    // 'resize' fires as the keyboard animates in/out; 'scroll' fires for the iOS
    // pan described above. Window 'resize'/'orientationchange' cover the rest
    // (rotation, PWA re-layout) and browsers with no visualViewport at all.
    vv?.addEventListener('resize', apply)
    vv?.addEventListener('scroll', apply)
    window.addEventListener('resize', apply)
    const onOrientation = (): void => {
      tallest = 0
      apply()
    }
    window.addEventListener('orientationchange', onOrientation)
    return () => {
      vv?.removeEventListener('resize', apply)
      vv?.removeEventListener('scroll', apply)
      window.removeEventListener('resize', apply)
      window.removeEventListener('orientationchange', onOrientation)
      root.style.removeProperty('--app-h')
      root.style.removeProperty('--app-top')
      root.style.removeProperty('--app-full-h')
      root.style.removeProperty('--app-tallest')
      delete root.dataset.keyboard
    }
  }, [])
}
