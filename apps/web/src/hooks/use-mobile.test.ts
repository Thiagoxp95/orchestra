import { describe, expect, it, beforeAll, vi } from 'vitest'

/**
 * The mobile drawer is gated on this hook and nothing remounts its provider, so a
 * wrong answer here doesn't repaint away — it kills the drawer until the PWA is
 * killed. Both properties below are the ones that used to be missing.
 */

type Listener = () => void

const mql = {
  matches: true,
  listeners: new Set<Listener>(),
  addEventListener: (_: string, fn: Listener) => mql.listeners.add(fn),
  removeEventListener: (_: string, fn: Listener) => mql.listeners.delete(fn),
}
const win = { events: new Map<string, Set<Listener>>(), innerWidth: 390 }
const doc = { events: new Map<string, Set<Listener>>() }

const on = (bag: Map<string, Set<Listener>>) => (type: string, fn: Listener) => {
  if (!bag.has(type)) bag.set(type, new Set())
  bag.get(type)!.add(fn)
}
const off = (bag: Map<string, Set<Listener>>) => (type: string, fn: Listener) => {
  bag.get(type)?.delete(fn)
}
const bound = (bag: Map<string, Set<Listener>>) =>
  [...bag].filter(([, fns]) => fns.size > 0).map(([type]) => type)

beforeAll(() => {
  vi.stubGlobal('window', {
    matchMedia: () => mql,
    addEventListener: on(win.events),
    removeEventListener: off(win.events),
    get innerWidth() {
      return win.innerWidth
    },
  })
  vi.stubGlobal('document', {
    addEventListener: on(doc.events),
    removeEventListener: off(doc.events),
  })
})

describe('readIsMobile', () => {
  it('follows the media query, not a width that lags it', async () => {
    const { readIsMobile } = await import('./use-mobile')
    // iOS during a rotation: the query has already flipped to desktop-width while
    // `window.innerWidth` still reports the portrait width — and vice versa. The old
    // hook read innerWidth here, and since `change` only fires on a flip, one stale
    // read stuck for the life of the page.
    mql.matches = false
    win.innerWidth = 390
    expect(readIsMobile()).toBe(false)

    mql.matches = true
    win.innerWidth = 852
    expect(readIsMobile()).toBe(true)
  })
})

describe('subscribeIsMobile', () => {
  it('re-checks on viewport events and on foreground, and unsubscribes cleanly', async () => {
    const { subscribeIsMobile } = await import('./use-mobile')
    const onChange = vi.fn()
    const unsubscribe = subscribeIsMobile(onChange)

    expect(mql.listeners.size).toBe(1)
    // A phone rotated while the PWA is backgrounded delivers no `change` we can
    // trust, so the foreground and the resize have to re-ask as well.
    expect(bound(win.events).sort()).toEqual(['orientationchange', 'resize'])
    expect(bound(doc.events)).toEqual(['visibilitychange'])

    for (const fns of [...win.events.values(), ...doc.events.values(), mql.listeners]) {
      for (const fn of fns) fn()
    }
    expect(onChange).toHaveBeenCalledTimes(4)

    unsubscribe()
    expect(mql.listeners.size).toBe(0)
    expect(bound(win.events)).toEqual([])
    expect(bound(doc.events)).toEqual([])
  })
})
