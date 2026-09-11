interface ScrollSurface {
  metrics(): { rowHeight: number; viewportY: number; baseY: number }
  scrollLines(lines: number): void
  requestFrame(callback: (time: number) => void): number
  cancelFrame(id: number): void
}

/** Local scrollback, independent of network latency and React renders.
 * Like Orca's mobile terminal, accumulate pixels and commit whole rows once
 * per frame. Never translate the canvas fractionally: that blurs TUI glyphs.
 */
export function createTerminalScroller(surface: ScrollSurface) {
  let frame: number | null = null
  let pending = 0
  let remainder = 0
  let velocity = 0
  let lastY = 0
  let lastTime = 0
  let touching = false

  const apply = (pixels: number): boolean => {
    const { rowHeight, viewportY, baseY } = surface.metrics()
    if (!Number.isFinite(rowHeight) || rowHeight <= 0) return false
    remainder += pixels
    if ((remainder < 0 && viewportY <= 0) || (remainder > 0 && viewportY >= baseY)) {
      remainder = 0
      return false
    }
    const rows = Math.trunc(remainder / rowHeight)
    const clamped = Math.max(-viewportY, Math.min(baseY - viewportY, rows))
    if (clamped !== 0) surface.scrollLines(clamped)
    remainder = clamped === rows ? remainder - clamped * rowHeight : 0
    return clamped === rows
  }

  const cancel = () => {
    if (frame !== null) surface.cancelFrame(frame)
    frame = null
  }
  const stop = () => {
    cancel()
    touching = false
    pending = remainder = velocity = 0
  }
  const paint = () => {
    frame = null
    const delta = pending
    pending = 0
    if (!apply(delta)) velocity = 0
  }
  const coast = (time: number) => {
    frame = null
    // Time-based decay behaves identically at 60/120Hz; a background pause
    // must not turn into an enormous leap when the page resumes.
    const elapsed = Math.min(32, Math.max(0, time - lastTime))
    lastTime = time
    velocity *= Math.exp(-elapsed / 240)
    if (Math.abs(velocity) < 0.02 || !apply(velocity * elapsed)) {
      velocity = 0
      return
    }
    frame = surface.requestFrame(coast)
  }

  return {
    start(y: number, time: number) {
      stop()
      touching = true
      lastY = y
      lastTime = time
    },
    move(y: number, time: number) {
      if (!touching) return
      const delta = lastY - y
      const elapsed = time - lastTime
      if (elapsed > 0) {
        const sample = Math.max(-3, Math.min(3, delta / elapsed))
        velocity = velocity === 0 ? sample : velocity * 0.55 + sample * 0.45
      }
      lastY = y
      lastTime = time
      pending += delta
      if (frame === null) frame = surface.requestFrame(paint)
    },
    end(time: number) {
      if (!touching) return
      touching = false
      cancel()
      if (pending) paint()
      if (time - lastTime > 100) velocity = 0
      lastTime = time
      if (Math.abs(velocity) >= 0.02) frame = surface.requestFrame(coast)
    },
    stop,
  }
}
