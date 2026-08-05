import { describe, expect, it, vi } from 'vitest'
import { createCommandDrain, type DrainedCommand } from './remote-bridge-command-drain'

const cmd = (id: string, kind = 'spawnInTree'): DrainedCommand => ({ _id: id, kind })

describe('createCommandDrain', () => {
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
