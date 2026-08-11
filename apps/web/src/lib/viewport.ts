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
  //
  // Clamped against `baseline`, NOT `layoutHeight`: in an installed iOS PWA
  // innerHeight shrinks with the keyboard (see tallestLayoutHeight above), so by
  // the time we get here layoutHeight ≈ height and `layoutHeight - height` is ~0
  // — which silently clamped a correct 300px offset to zero. The shell then sat
  // at layout y=0 while iOS held the window 300px lower, putting its top edge
  // that far above the visible strip: the composer and action bar crammed under
  // the status bar with a screenful of background beneath them. The unshrunk
  // height is the only sound reference for how far the shell may travel.
  const top = Math.max(0, Math.min(Math.round(vv.offsetTop), baseline - height))
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
/**
 * Let go of a composer that is still focused behind a hidden soft keyboard.
 *
 * Hold-to-talk cancels its pointerdown default so that grabbing the mic mid-typing
 * doesn't collapse an open keyboard (iOS blurs the textarea otherwise). The cost
 * shows up on Android: hiding the keyboard with the back gesture leaves the
 * textarea focused, and Chrome re-summons the keyboard for a still-focused
 * editable on the next touch anywhere on the page — so reaching for the mic threw
 * the keyboard back over the conversation. Dropping that stale focus first is the
 * fix, gated on the keyboard being closed so the iOS case keeps its behaviour.
 *
 * Reads the flag `useAppViewport` already publishes, so "closed" here means the
 * same thing it means to the layout.
 */
export function releaseHiddenKeyboardFocus(): void {
  if (typeof document === 'undefined') return
  if (document.documentElement.dataset.keyboard === 'open') return
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable) el.blur()
}

/**
 * The iOS half of the zoom lock (the meta tag in layout.tsx and `touch-action`
 * in globals.css are the other half).
 *
 * Safari has ignored `user-scalable=no` since iOS 10 and does not let
 * `touch-action` veto a *page* pinch, so on an iPad the shell can still be
 * magnified — and once it is, the layout viewport is wider than the strip on
 * screen and the right side of the chat is cropped with no way back, because the
 * pinch that would undo it is the app's own "zoom out to the sessions overview"
 * gesture. WebKit's proprietary `gesture*` events are the one hook that stops it:
 * cancelling them leaves the page at 1:1 while every touch handler underneath
 * (the two-finger roll, the pinch to the overview) still sees its raw touches.
 *
 * `dblclick` goes with them — double-tap-to-zoom is the same trap arrived at by
 * a different route, and nothing in this app treats a double click as input.
 */
export function useLockZoom(): void {
  useEffect(() => {
    const block = (e: Event): void => e.preventDefault()
    // Non-passive: a passive listener's preventDefault is ignored, which is the
    // default Safari would otherwise pick for touch-ish events.
    const opts = { passive: false } as const
    document.addEventListener('gesturestart', block, opts)
    document.addEventListener('gesturechange', block, opts)
    document.addEventListener('gestureend', block, opts)
    document.addEventListener('dblclick', block, opts)
    return () => {
      document.removeEventListener('gesturestart', block)
      document.removeEventListener('gesturechange', block)
      document.removeEventListener('gestureend', block)
      document.removeEventListener('dblclick', block)
    }
  }, [])
}

export function useAppViewport(): void {
  useEffect(() => {
    const root = document.documentElement
    // Tallest layout viewport seen since the last rotation — the "no keyboard"
    // reference (see appViewport). Reset on orientationchange, where the real
    // full height changes and yesterday's maximum means nothing.
    let tallest = 0
    const apply = (): void => {
      tallest = Math.max(tallest, window.innerHeight)
      const { height, top, keyboardOpen } = appViewport(
        window.innerHeight,
        window.visualViewport,
        tallest,
      )
      root.style.setProperty('--app-h', `${height}px`)
      root.style.setProperty('--app-top', `${top}px`)
      root.style.setProperty('--app-full-h', `${window.innerHeight}px`)
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
      delete root.dataset.keyboard
    }
  }, [])
}
