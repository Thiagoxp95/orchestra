import { describe, expect, it, vi } from 'vitest'
import { createApplyQueue } from './remote-bridge-apply-queue'

describe('createApplyQueue', () => {
  /** Let queued microtasks run (the queue heals, then applies — several hops). */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  it('serializes batches — a slow batch finishes before the next starts', async () => {
    const order: string[] = []
    const gate: Array<() => void> = []
    const queue = createApplyQueue(async (batch) => {
      const name = String(batch[0])
      order.push(`start:${name}`)
      await new Promise<void>((resolve) => gate.push(resolve))
      order.push(`end:${name}`)
    })
    queue.enqueue(['a'])
    queue.enqueue(['b'])
    await flush()
    // 'b' must not have started while 'a' is still in flight.
    expect(order).toEqual(['start:a'])
    gate.shift()!()
    await flush()
    expect(order).toEqual(['start:a', 'end:a', 'start:b'])
    gate.shift()!()
    await queue.idle()
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
  })

  it('keeps running after a batch rejects — the v1.21.28 permanent-death regression', async () => {
    const applied: string[] = []
    const onError = vi.fn()
    const queue = createApplyQueue(async (batch) => {
      const name = String(batch[0])
      if (name === 'boom') throw new Error('apply failed')
      applied.push(name)
    }, onError)

    queue.enqueue(['boom'])
    queue.enqueue(['after-1'])
    queue.enqueue(['after-2'])
    await queue.idle()

    expect(applied).toEqual(['after-1', 'after-2'])
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('survives repeated failures without wedging', async () => {
    const applied: string[] = []
    const queue = createApplyQueue(async (batch) => {
      const name = String(batch[0])
      if (name.startsWith('bad')) throw new Error(name)
      applied.push(name)
    })
    for (const name of ['bad-1', 'ok-1', 'bad-2', 'bad-3', 'ok-2']) queue.enqueue([name])
    await queue.idle()
    expect(applied).toEqual(['ok-1', 'ok-2'])
  })

  it('enqueue never throws synchronously even when apply throws synchronously', async () => {
    const queue = createApplyQueue(() => {
      throw new Error('sync boom')
    })
    expect(() => queue.enqueue(['x'])).not.toThrow()
    await queue.idle()
  })
})
