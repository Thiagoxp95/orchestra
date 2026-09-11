import { describe, expect, it } from 'vitest'
import { createTerminalScroller } from './terminal-kinetics'

function surface() {
  let position = 500
  let frame: ((time: number) => void) | undefined
  const paints: number[] = []
  const scroller = createTerminalScroller({
    metrics: () => ({ rowHeight: 10, viewportY: position, baseY: 1000 }),
    scrollLines: (lines) => { position += lines; paints.push(position) },
    requestFrame: (callback) => { frame = callback; return 1 },
    cancelFrame: () => { frame = undefined },
  })
  return {
    scroller, paints, position: () => position,
    tick(time: number) { const callback = frame; frame = undefined; callback?.(time) },
    pending: () => !!frame,
  }
}

describe('terminal touch scrolling', () => {
  it('coalesces many moves into one paint and carries fractional rows', () => {
    const s = surface()
    s.scroller.start(100, 0)
    s.scroller.move(96, 10)
    s.scroller.move(92, 20)
    s.scroller.move(86, 30)
    expect(s.paints).toEqual([])
    s.tick(32)
    expect(s.paints).toEqual([501])
    s.scroller.move(80, 40)
    s.tick(48)
    expect(s.paints).toEqual([501, 502])
  })

  it('continues a flick after release and a new touch interrupts momentum', () => {
    const s = surface()
    s.scroller.start(100, 0)
    s.scroller.move(0, 20)
    s.tick(20)
    s.scroller.end(20)
    s.tick(36)
    expect(s.position()).toBeGreaterThan(510)
    s.scroller.start(80, 40)
    const stopped = s.position()
    s.tick(52)
    expect(s.position()).toBe(stopped)
    expect(s.pending()).toBe(false)
  })

  it('does not fling after the finger pauses before lifting', () => {
    const s = surface()
    s.scroller.start(100, 0)
    s.scroller.move(0, 20)
    s.tick(20)
    s.scroller.end(400)
    s.tick(416)
    expect(s.position()).toBe(510)
    expect(s.pending()).toBe(false)
  })

  it('clamps at history boundaries and releases its animation frame', () => {
    const s = surface()
    s.scroller.start(0, 0)
    s.scroller.move(9000, 20)
    s.tick(20)
    s.scroller.end(20)
    s.tick(36)
    expect(s.position()).toBe(0)
    expect(s.pending()).toBe(false)
  })

  it('does not inherit momentum from a canceled or multi-finger gesture', () => {
    const s = surface()
    s.scroller.start(100, 0)
    s.scroller.move(0, 20)
    s.scroller.stop()
    s.scroller.end(30)
    s.tick(46)
    expect(s.position()).toBe(500)
    expect(s.pending()).toBe(false)
  })
})
