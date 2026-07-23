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

  it('never reports more than the layout height', () => {
    expect(appViewport(800, { height: 900, offsetTop: 0, scale: 1 }).height).toBe(800)
  })
})
