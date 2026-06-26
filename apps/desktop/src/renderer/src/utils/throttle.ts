/**
 * Leading + trailing throttle. Invokes `fn` immediately on the first call after
 * an idle gap, then at most once per `intervalMs`, always delivering the latest
 * args via a trailing call once the window closes.
 *
 * Unlike a debounce, a continuous stream of calls can NEVER starve it — it keeps
 * firing every `intervalMs`. The remote mirror relies on this: the old code
 * pushed desktop state to the bridge only when the 1s save-state debounce fired,
 * and that debounce was reset by every store change, so the burst of updates a
 * freshly-spawned agent emits while booting starved the push and left the phone's
 * sidebar seconds behind the desktop. A leading-edge throttle shows the change on
 * mobile at once; the trailing edge guarantees the settled state lands too.
 */
export function createThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number,
): (...args: A) => void {
  // -Infinity so the very first call always reads as "idle long enough" and
  // fires on the leading edge (a real timestamp can never look stale otherwise).
  let last = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: A | null = null

  const fire = (args: A): void => {
    last = Date.now()
    fn(...args)
  }

  return (...args: A): void => {
    const elapsed = Date.now() - last
    if (elapsed >= intervalMs) {
      // Idle past the window (or first call): fire now, cancel any trailing fire.
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      pending = null
      fire(args)
      return
    }
    // Inside the window: keep only the latest args and ensure one trailing fire.
    pending = args
    if (!timer) {
      timer = setTimeout(() => {
        timer = null
        const p = pending as A
        pending = null
        fire(p)
      }, intervalMs - elapsed)
    }
  }
}
