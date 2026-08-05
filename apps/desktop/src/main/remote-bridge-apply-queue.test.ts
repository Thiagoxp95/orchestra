import { describe, expect, it, vi } from 'vitest'
import { createApplyQueue } from './remote-bridge-apply-queue'

describe('createApplyQueue', () => {
  /** Let queued microtasks run (the pump loops through several hops). */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  it('serializes snapshots — a slow one finishes before the next starts', async () => {
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

  it('latest wins — snapshots that queue up behind a slow one are superseded, not replayed', async () => {
    // The v1.21.30 spawn storm: each queued snapshot was drained in full, so a
    // command captured in 60 of them was applied 60 times. Only the newest
    // waiting snapshot may run once the slow one finishes.
    const applied: string[][] = []
    const gate: Array<() => void> = []
    const queue = createApplyQueue(async (batch) => {
      applied.push(batch as string[])
      await new Promise<void>((resolve) => gate.push(resolve))
    })
    queue.enqueue(['s1'])
    await flush()
    queue.enqueue(['s1', 'k1'])
    queue.enqueue(['s1', 'k1', 'k2'])
    queue.enqueue(['s1', 'k1', 'k2', 'k3'])
    gate.shift()!()
    await flush()
    gate.shift()!()
    await queue.idle()
    expect(applied).toEqual([['s1'], ['s1', 'k1', 'k2', 'k3']])
  })

  it('keeps running after a snapshot rejects — the v1.21.28 permanent-death regression', async () => {
    const applied: string[] = []
    const onError = vi.fn()
    const queue = createApplyQueue(async (batch) => {
      const name = String(batch[0])
      if (name === 'boom') throw new Error('apply failed')
      applied.push(name)
    }, onError)

    queue.enqueue(['boom'])
    await queue.idle()
    queue.enqueue(['after'])
    await queue.idle()

    expect(applied).toEqual(['after'])
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('survives repeated failures without wedging', async () => {
    const applied: string[] = []
    const queue = createApplyQueue(async (batch) => {
      const name = String(batch[0])
      if (name.startsWith('bad')) throw new Error(name)
      applied.push(name)
    })
    for (const name of ['bad-1', 'ok-1', 'bad-2', 'bad-3']) {
      queue.enqueue([name])
      await queue.idle()
    }
    queue.enqueue(['ok-2'])
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

  it('a throwing onError handler does not kill the pump', async () => {
    const applied: string[] = []
    const queue = createApplyQueue(
      async (batch) => {
        const name = String(batch[0])
        if (name === 'boom') throw new Error('apply failed')
        applied.push(name)
      },
      () => {
        throw new Error('handler boom')
      },
    )
    queue.enqueue(['boom'])
    await queue.idle()
    queue.enqueue(['after'])
    await queue.idle()
    expect(applied).toEqual(['after'])
  })
})
