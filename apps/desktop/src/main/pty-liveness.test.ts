import { describe, it, expect } from 'vitest'
import { PtyLiveness, PTY_DEAD_GRACE_MS } from './pty-liveness'

const alive = (id: string) => ({ sessionId: id, isAlive: true })
const dead = (id: string) => ({ sessionId: id, isAlive: false })

describe('PtyLiveness', () => {
  it('marks a store session dead only after the grace window', () => {
    const t = new PtyLiveness()
    expect(t.update([], ['a'], 0)).toEqual([])
    expect(t.isDead('a')).toBe(false)
    expect(t.update([], ['a'], PTY_DEAD_GRACE_MS - 1)).toEqual([])
    expect(t.isDead('a')).toBe(false)
    expect(t.update([], ['a'], PTY_DEAD_GRACE_MS)).toEqual(['a'])
    expect(t.isDead('a')).toBe(true)
    // Verdict flips once, not on every later poll.
    expect(t.update([], ['a'], PTY_DEAD_GRACE_MS + 5_000)).toEqual([])
  })

  it('a daemon-listed but isAlive:false PTY counts as gone', () => {
    const t = new PtyLiveness()
    t.update([dead('a')], ['a'], 0)
    expect(t.update([dead('a')], ['a'], PTY_DEAD_GRACE_MS)).toEqual(['a'])
  })

  it('never flags a newborn that attaches between polls', () => {
    const t = new PtyLiveness()
    // Session appears in the store while the poller's last daemon view predates it…
    expect(t.update([], ['new'], 0)).toEqual([])
    // …and by the next poll the daemon owns it. The clock never reaches the grace.
    expect(t.update([alive('new')], ['new'], 5_000)).toEqual([])
    expect(t.update([], ['new'], 10_000)).toEqual([])
    expect(t.isDead('new')).toBe(false)
  })

  it('clears the verdict when the desktop reopens the session', () => {
    const t = new PtyLiveness()
    t.update([], ['a'], 0)
    expect(t.update([], ['a'], PTY_DEAD_GRACE_MS)).toEqual(['a'])
    expect(t.update([alive('a')], ['a'], PTY_DEAD_GRACE_MS + 1_000)).toEqual(['a'])
    expect(t.isDead('a')).toBe(false)
    // Going missing again restarts the clock from scratch.
    expect(t.update([], ['a'], PTY_DEAD_GRACE_MS + 2_000)).toEqual([])
    expect(t.isDead('a')).toBe(false)
  })

  it('forgets sessions that leave the store', () => {
    const t = new PtyLiveness()
    t.update([], ['a'], 0)
    t.update([], ['a'], PTY_DEAD_GRACE_MS)
    expect(t.isDead('a')).toBe(true)
    t.update([], [], PTY_DEAD_GRACE_MS + 1_000)
    expect(t.isDead('a')).toBe(false)
    // Re-created under the same id: fresh clock, no instant verdict.
    expect(t.update([], ['a'], PTY_DEAD_GRACE_MS + 2_000)).toEqual([])
    expect(t.isDead('a')).toBe(false)
  })

  it('only isAlive daemon sessions count as owned', () => {
    const t = new PtyLiveness()
    t.update([alive('a'), dead('b')], ['a', 'b'], 0)
    const changed = t.update([alive('a'), dead('b')], ['a', 'b'], PTY_DEAD_GRACE_MS)
    expect(changed).toEqual(['b'])
    expect(t.isDead('a')).toBe(false)
    expect(t.isDead('b')).toBe(true)
  })
})
