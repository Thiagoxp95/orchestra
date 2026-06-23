import { describe, expect, it } from 'vitest'
import { ChunkSeq } from './remote-bridge-seq'

describe('ChunkSeq', () => {
  it('allocates from 0 and increments', () => {
    const s = new ChunkSeq()
    expect(s.next('a')).toBe(0)
    expect(s.next('a')).toBe(1)
    expect(s.next('a')).toBe(2)
  })

  it('tracks sessions independently', () => {
    const s = new ChunkSeq()
    expect(s.next('a')).toBe(0)
    expect(s.next('b')).toBe(0)
    expect(s.next('a')).toBe(1)
    expect(s.next('b')).toBe(1)
  })

  it('NEVER resets across re-attach — a re-seed lands above an old cursor', () => {
    const s = new ChunkSeq()
    // First attach: seed + a few stream chunks.
    expect(s.next('a')).toBe(0) // seed
    expect(s.next('a')).toBe(1)
    expect(s.next('a')).toBe(2) // a web client's afterSeq is now 2
    // Re-attach (2nd viewer / wake re-seed / respawn): the seed must be > 2 so
    // getChunks(gt 2) still returns it to the already-watching client.
    expect(s.next('a')).toBe(3) // re-seed
    expect(s.next('a')).toBe(4)
  })

  it('init primes the counter from the persisted head on cold start', () => {
    const s = new ChunkSeq()
    s.init('a', 41) // headSeq read from Convex after a restart
    expect(s.next('a')).toBe(42)
    expect(s.next('a')).toBe(43)
  })

  it('init is a no-op once the session is tracked (in-process monotonicity wins)', () => {
    const s = new ChunkSeq()
    expect(s.next('a')).toBe(0)
    expect(s.next('a')).toBe(1)
    s.init('a', 0) // a stale/lower head must not lower the live counter
    expect(s.next('a')).toBe(2)
  })

  it('init with an empty head (-1) starts at 0', () => {
    const s = new ChunkSeq()
    s.init('a', -1)
    expect(s.next('a')).toBe(0)
  })

  it('has() reflects whether a session is tracked', () => {
    const s = new ChunkSeq()
    expect(s.has('a')).toBe(false)
    s.next('a')
    expect(s.has('a')).toBe(true)
    const s2 = new ChunkSeq()
    s2.init('b', 5)
    expect(s2.has('b')).toBe(true)
  })
})
