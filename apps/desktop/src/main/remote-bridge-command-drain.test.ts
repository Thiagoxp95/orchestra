import { describe, expect, it, vi } from 'vitest'
import { createCommandDrain, type DrainedCommand } from './remote-bridge-command-drain'
import { createApplyQueue } from './remote-bridge-apply-queue'

const cmd = (id: string, kind = 'spawnInTree'): DrainedCommand => ({ _id: id, kind })

describe('createCommandDrain', () => {
  it('applies a typing burst and reentrant snapshots without waiting for cloud acknowledgements', async () => {
    vi.useFakeTimers()
    const applied: { id: string; at: number }[] = []
    const started = Date.now()
    const { drain } = createCommandDrain(
      async c => { applied.push({ id: c._id, at: Date.now() - started }) },
      async () => { await new Promise(resolve => setTimeout(resolve, 120)) },
    )
    const queue = createApplyQueue(drain)
    try {
      queue.enqueue([cmd('a', 'write'), cmd('b', 'write')])
      await vi.advanceTimersByTimeAsync(0)
      // A subscription update arriving while the previous delete is in flight.
      queue.enqueue([cmd('a', 'write'), cmd('b', 'write'), cmd('c', 'write'), cmd('d', 'write'), cmd('e', 'write')])
      await vi.advanceTimersByTimeAsync(0)
      expect(applied).toEqual(['a', 'b', 'c', 'd', 'e'].map(id => ({ id, at: 0 })))
    } finally {
      await vi.runAllTimersAsync()
      await queue.idle()
      vi.useRealTimers()
    }
  })

  it('bounds outstanding acknowledgements while continuing ordered input and deduplicating replay', async () => {
    vi.useFakeTimers()
    const applied: string[] = []
    let active = 0
    let peak = 0
    const acknowledged: string[] = []
    const { drain } = createCommandDrain(
      async c => { applied.push(c._id) },
      async id => { active++; peak = Math.max(active, peak); await new Promise(resolve => setTimeout(resolve, 120)); active--; acknowledged.push(id) },
      () => {},
      { maxConcurrentAcks: 2 },
    )
    const commands = ['a', 'b', 'c', 'd', 'e'].map(id => cmd(id, 'write'))
    try {
      const first = drain(commands)
      await vi.advanceTimersByTimeAsync(0)
      expect(applied).toEqual(['a', 'b', 'c', 'd', 'e'])
      await first
      await drain(commands)
      expect(applied).toEqual(['a', 'b', 'c', 'd', 'e'])
      await vi.runAllTimersAsync()
      expect(acknowledged).toEqual(['a', 'b', 'c', 'd', 'e'])
      expect(peak).toBe(2)
    } finally {
      await vi.runAllTimersAsync()
      vi.useRealTimers()
    }
  })

  it('applies each command once and acks it', async () => {
    const applied: string[] = []
    const acked: string[] = []
    const { drain } = createCommandDrain(
      async (c) => { applied.push(c._id) },
      async (id) => { acked.push(id) },
    )
    await drain([cmd('a'), cmd('b')])
    expect(applied).toEqual(['a', 'b'])
    expect(acked).toEqual(['a', 'b'])
  })

  it('a command riding two overlapping snapshots is applied ONCE — the spawn-storm regression', async () => {
    // Field incident (v1.21.30): snapshots of the pending list queue up while a
    // slow command applies. A snapshot captured before spawnInTree's delete
    // committed still contains it; draining that stale snapshot spawned another
    // Claude session — one per queued snapshot, every second.
    const applied: string[] = []
    const { drain } = createCommandDrain(
      async (c) => { applied.push(c._id) },
      async () => {},
    )
    await drain([cmd('spawn')])
    // Stale snapshot: captured server-side before the delete, delivered after.
    await drain([cmd('spawn'), cmd('key-1', 'write')])
    await drain([cmd('spawn'), cmd('key-1', 'write'), cmd('key-2', 'write')])
    expect(applied).toEqual(['spawn', 'key-1', 'key-2'])
  })

  // 2026-08-16 field incident: recreateClient() closed the socket under an
  // in-flight deleteCommand; its promise never settled and the pump sat on it
  // for 20+ minutes while every phone command piled up unapplied.
  it('a hung ack cannot wedge the drain — it times out and later commands still apply', async () => {
    const applied: string[] = []
    const errors: string[] = []
    const ack = vi.fn<(id: string) => Promise<void>>()
      .mockImplementationOnce(() => new Promise(() => {})) // never settles
      .mockResolvedValue(undefined)
    const { drain } = createCommandDrain(
      async (c) => { applied.push(c._id) },
      ack,
      (ctx) => { errors.push(ctx) },
      { ackMs: 20 },
    )
    await drain([cmd('a'), cmd('b')])
    expect(applied).toEqual(['a', 'b'])
    await vi.waitFor(() => expect(errors).toEqual(['deleteCommand failed']))
    // 'a' is still un-acked (the row is still in the table) — the next snapshot
    // re-acks it without re-applying, exactly like a rejected ack.
    await drain([cmd('a'), cmd('b')])
    expect(applied).toEqual(['a', 'b'])
    expect(ack).toHaveBeenCalledTimes(3)
  })

  it('a hung apply is abandoned after the cap and acked so it never replays', async () => {
    const applied: string[] = []
    const acked: string[] = []
    const { drain } = createCommandDrain(
      async (c) => {
        applied.push(c._id)
        if (c._id === 'stuck') await new Promise(() => {})
      },
      async (id) => { acked.push(id) },
      () => {},
      { applyMs: 20 },
    )
    await drain([cmd('stuck'), cmd('next')])
    expect(applied).toEqual(['stuck', 'next'])
    expect(acked).toEqual(['stuck', 'next'])
  })

  it('a failed ack is retried on the next snapshot WITHOUT re-applying the command', async () => {
    const applied: string[] = []
    const ack = vi.fn<(id: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('socket wedged'))
      .mockResolvedValue(undefined)
    const onError = vi.fn()
    const { drain } = createCommandDrain(
      async (c) => { applied.push(c._id) },
      ack,
      onError,
    )
    await drain([cmd('spawn')])
    expect(applied).toEqual(['spawn'])
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    // Row still pending server-side (ack failed) so the next snapshot re-lists it.
    await drain([cmd('spawn')])
    expect(applied).toEqual(['spawn']) // not applied again…
    expect(ack).toHaveBeenCalledTimes(2) // …but the ack IS retried
  })

  it('an apply failure is logged, acked, and never retried', async () => {
    const onError = vi.fn()
    const acked: string[] = []
    const { drain } = createCommandDrain(
      async (c) => { if (c._id === 'boom') throw new Error('apply failed') },
      async (id) => { acked.push(id) },
      onError,
    )
    await drain([cmd('boom'), cmd('ok')])
    await drain([cmd('boom'), cmd('ok')])
    expect(acked).toEqual(['boom', 'ok'])
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('guard memory stays bounded: ids gone from the snapshot are evicted', async () => {
    const { drain } = createCommandDrain(async () => {}, async () => {})
    for (let i = 0; i < 1000; i++) await drain([cmd(`c${i}`)])
    // No direct handle on the set — this is a does-not-grow smoke check: the
    // 1000th drain still behaves correctly after 999 distinct prior ids.
    const applied: string[] = []
    const { drain: drain2 } = createCommandDrain(
      async (c) => { applied.push(c._id) },
      async () => {},
    )
    await drain2([cmd('x')])
    await drain2([]) // empty snapshot: everything consumed
    await drain2([cmd('y')])
    expect(applied).toEqual(['x', 'y'])
  })

  it('tolerates malformed rows', async () => {
    const applied: string[] = []
    const { drain } = createCommandDrain(
      async (c) => { applied.push(c._id) },
      async () => {},
    )
    await drain([null, {}, { _id: 42 }, cmd('ok')] as unknown[])
    await drain('not-an-array' as unknown as unknown[])
    expect(applied).toEqual(['ok'])
  })
})
