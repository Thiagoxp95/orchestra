'use client'
import { useCallback, useEffect, useRef } from 'react'

/**
 * A callback with a STABLE identity that always runs the latest closure.
 *
 * The point is memoization that actually holds: this pane re-renders several
 * times a second while an agent works (every mirror push moves its props), and
 * a child handed a fresh `onApply` on each of those renders re-renders too —
 * `memo` or not. Handing it one of these instead lets the child sit still
 * through the stream while the handler it fires is still the current one.
 *
 * The ref is updated in an effect (not during render) so it stays a valid
 * concurrent-rendering citizen; user events fire long after effects flush.
 */
export function useEventCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}
