import * as React from 'react'

/**
 * A wall-clock value that re-renders the component every `intervalMs`. Used to
 * keep time-since-last-push checks (bridge liveness) ticking — Convex only
 * re-renders when the mirrored *data* changes, so without an independent tick the
 * "desktop offline" banner would never appear until the next unrelated update.
 *
 * The interval is paused while the tab is hidden (a backgrounded PWA shouldn't
 * burn timers) and a fresh value is taken on every return to the foreground, so
 * the banner reflects reality the instant the user looks again.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const tick = () => setNow(Date.now())

    const start = () => {
      if (timer == null) timer = setInterval(tick, intervalMs)
    }
    const stop = () => {
      if (timer != null) {
        clearInterval(timer)
        timer = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        tick()
        start()
      } else {
        stop()
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    if (document.visibilityState === 'visible') start()

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [intervalMs])

  return now
}
