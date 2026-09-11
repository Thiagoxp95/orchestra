/** Native-keyboard cadence, with one cancellable timer per held key. */
export function createKeyRepeat(press: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const tick = () => {
    timer = setTimeout(tick, 50)
    press()
  }
  return {
    start() {
      stop()
      timer = setTimeout(tick, 350)
      press()
    },
    stop,
  }
}
