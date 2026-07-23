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
): AppViewport {
  const full: AppViewport = { height: layoutHeight, top: 0, keyboardOpen: false }
  if (!vv || layoutHeight <= 0 || vv.height <= 0) return full
  if (vv.scale > 1.01) return full
  const height = Math.min(layoutHeight, Math.round(vv.height))
  // iOS pans the visual viewport down over the layout viewport when it wants to
  // reveal a focused element the keyboard would cover (the page itself can't
  // scroll here). Offsetting the shell by the same amount keeps it exactly on the
  // visible strip instead of half off the top of the screen.
  const top = Math.max(0, Math.min(Math.round(vv.offsetTop), layoutHeight - height))
  return { height, top, keyboardOpen: layoutHeight - height >= KEYBOARD_MIN_INSET_PX }
}

/**
 * Publish the visual viewport on `<html>` as `--app-h` / `--app-top`, plus a
 * `data-keyboard` flag, and keep them current as the keyboard opens and closes.
 * Mount once; the shell consumes the variables (see page.tsx / globals.css).
 *
 * `top` is applied as a margin rather than a transform on purpose: a transformed
 * ancestor would become the containing block for `position: fixed` descendants,
 * which the Linear ticket card relies on resolving against the viewport.
 */
export function useAppViewport(): void {
  useEffect(() => {
    const root = document.documentElement
    const apply = (): void => {
      const { height, top, keyboardOpen } = appViewport(window.innerHeight, window.visualViewport)
      root.style.setProperty('--app-h', `${height}px`)
      root.style.setProperty('--app-top', `${top}px`)
      root.dataset.keyboard = keyboardOpen ? 'open' : 'closed'
    }
    apply()
    const vv = window.visualViewport
    // 'resize' fires as the keyboard animates in/out; 'scroll' fires for the iOS
    // pan described above. Window 'resize'/'orientationchange' cover the rest
    // (rotation, PWA re-layout) and browsers with no visualViewport at all.
    vv?.addEventListener('resize', apply)
    vv?.addEventListener('scroll', apply)
    window.addEventListener('resize', apply)
    window.addEventListener('orientationchange', apply)
    return () => {
      vv?.removeEventListener('resize', apply)
      vv?.removeEventListener('scroll', apply)
      window.removeEventListener('resize', apply)
      window.removeEventListener('orientationchange', apply)
      root.style.removeProperty('--app-h')
      root.style.removeProperty('--app-top')
      delete root.dataset.keyboard
    }
  }, [])
}
