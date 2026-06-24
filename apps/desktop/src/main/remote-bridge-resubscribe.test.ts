import { describe, it, expect, vi } from 'vitest'
import { createResubscriber } from './remote-bridge-resubscribe'

describe('createResubscriber', () => {
  it('creates a subscription on first resubscribe', () => {
    const subscribe = vi.fn(() => vi.fn())
    const r = createResubscriber(subscribe)
    expect(r.active).toBe(false)
    r.resubscribe()
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(r.active).toBe(true)
  })

  it('disposes the previous subscription before creating the next', () => {
    const order: string[] = []
    let n = 0
    const subscribe = vi.fn(() => {
      const id = ++n
      return () => order.push(`dispose-${id}`)
    })
    const r = createResubscriber(subscribe)

    r.resubscribe() // create #1
    order.push('mark')
    r.resubscribe() // dispose #1, then create #2

    // Old handle is torn down before the marker between the two resubscribes...
    expect(order).toEqual(['mark', 'dispose-1'])
    // ...and only the newest subscription remains live (no leaked stack).
    expect(subscribe).toHaveBeenCalledTimes(2)
  })

  it('never leaves two subscriptions live at once', () => {
    let live = 0
    let peak = 0
    const subscribe = () => {
      live++
      peak = Math.max(peak, live)
      return () => {
        live--
      }
    }
    const r = createResubscriber(subscribe)
    for (let i = 0; i < 5; i++) r.resubscribe()
    expect(live).toBe(1)
    expect(peak).toBe(1)
  })

  it('stop disposes the subscription and goes inactive', () => {
    const unsubscribe = vi.fn()
    const r = createResubscriber(() => unsubscribe)
    r.resubscribe()
    r.stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(r.active).toBe(false)
  })

  it('stop is a no-op when nothing is subscribed', () => {
    const subscribe = vi.fn(() => vi.fn())
    const r = createResubscriber(subscribe)
    expect(() => r.stop()).not.toThrow()
    expect(subscribe).not.toHaveBeenCalled()
  })
})
