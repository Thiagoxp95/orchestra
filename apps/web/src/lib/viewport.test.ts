import { describe, it, expect } from 'vitest'
import { appViewport, KEYBOARD_MIN_INSET_PX } from './viewport'

describe('appViewport', () => {
  it('uses the full layout height when nothing occludes it', () => {
    expect(appViewport(800, { height: 800, offsetTop: 0, scale: 1 })).toEqual({
      height: 800,
      top: 0,
      keyboardOpen: false,
    })
  })

  it('shrinks to the visible strip when the keyboard is up', () => {
    const box = appViewport(800, { height: 460, offsetTop: 0, scale: 1 })
    expect(box.height).toBe(460)
    expect(box.keyboardOpen).toBe(true)
  })

  it('does not call a browser toolbar a keyboard', () => {
    const inset = KEYBOARD_MIN_INSET_PX - 1
    expect(appViewport(800, { height: 800 - inset, offsetTop: 0, scale: 1 }).keyboardOpen).toBe(false)
  })

  // The installed iOS PWA reports a visual viewport ~100px short for a while
  // after the keyboard closes. Shrinking for that left the usage strip hovering
  // above a screenful of dead background.
  it('does not shrink for a sub-keyboard inset', () => {
    const inset = KEYBOARD_MIN_INSET_PX - 1
    expect(appViewport(800, { height: 800 - inset, offsetTop: 0, scale: 1 })).toEqual({
      height: 800,
      top: 0,
      keyboardOpen: false,
    })
    expect(appViewport(800, { height: 800 - inset, offsetTop: 0, scale: 1 }, 800).height).toBe(800)
  })

  it('follows the iOS pan so the shell stays on the visible strip', () => {
    expect(appViewport(800, { height: 460, offsetTop: 120, scale: 1 })).toEqual({
      height: 460,
      top: 120,
      keyboardOpen: true,
    })
  })

  it('clamps the offset so the shell can never hang off the bottom', () => {
    expect(appViewport(800, { height: 460, offsetTop: 999, scale: 1 }).top).toBe(340)
  })

  it('ignores a pinch-zoomed visual viewport', () => {
    expect(appViewport(800, { height: 300, offsetTop: 200, scale: 2.5 })).toEqual({
      height: 800,
      top: 0,
      keyboardOpen: false,
    })
  })

  it('falls back to the layout height without a visual viewport', () => {
    expect(appViewport(800, null)).toEqual({ height: 800, top: 0, keyboardOpen: false })
    expect(appViewport(800, undefined)).toEqual({ height: 800, top: 0, keyboardOpen: false })
  })

  it('ignores a zero-sized visual viewport (mid-layout measurement)', () => {
    expect(appViewport(800, { height: 0, offsetTop: 0, scale: 1 }).height).toBe(800)
  })

  // An installed iOS PWA shrinks window.innerHeight along with the keyboard, so
  // layoutHeight alone can't see the occlusion — the strip stayed visible with
  // the keyboard up until the tallest-seen height became the reference.
  it('sees the keyboard when the layout viewport shrank with it', () => {
    expect(appViewport(460, { height: 460, offsetTop: 0, scale: 1 }).keyboardOpen).toBe(false)
    expect(appViewport(460, { height: 460, offsetTop: 0, scale: 1 }, 800).keyboardOpen).toBe(true)
  })

  it('ignores a tallest height that is shorter than the current layout', () => {
    expect(appViewport(800, { height: 460, offsetTop: 0, scale: 1 }, 600).keyboardOpen).toBe(true)
    expect(appViewport(800, { height: 800, offsetTop: 0, scale: 1 }, 600).keyboardOpen).toBe(false)
  })

  it('never reports more than the layout height', () => {
    expect(appViewport(800, { height: 900, offsetTop: 0, scale: 1 }).height).toBe(800)
  })
})
