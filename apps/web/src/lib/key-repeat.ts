/**
 * Native-keyboard cadence, with one cancellable timer per held key. The first
 * character waits for release (or for the hold to turn into a repeat), so a
 * press that becomes a swipe can still be cancelled without sending anything.
 */
export function createKeyRepeat(press: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  const stop = () => {
    clearTimeout(timer)
    timer = undefined
    pending = false
  }
  const tick = () => {
    pending = false
    timer = setTimeout(tick, 50)
    press()
  }
  return {
    start() {
      stop()
      pending = true
      timer = setTimeout(tick, 350)
    },
    /** Finger up: a tap that never repeated still sends its one character. */
    release() {
      const tap = pending
      stop()
      if (tap) press()
    },
    /** Cancel without sending. */
    stop,
  }
}
