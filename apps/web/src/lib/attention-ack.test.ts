import { describe, it, expect } from 'vitest'
import { applyAttentionAck, nextAcknowledged, type AckStatusLike } from './attention-ack'

const ack = (ids: string[] = []) => new Set(ids)
const status = (s: Record<string, AckStatusLike>) => s

describe('nextAcknowledged', () => {
  it('acknowledges the session being viewed while it asks', () => {
    const next = nextAcknowledged(ack(), status({ a: { work: 'idle', attention: 'input' } }), 'a')
    expect(next && [...next]).toEqual(['a'])
  })

  it('acknowledges an approval request the same way', () => {
    const next = nextAcknowledged(ack(), status({ a: { attention: 'approval' } }), 'a')
    expect(next && [...next]).toEqual(['a'])
  })

  it('does not acknowledge a quiet session you happen to be viewing', () => {
    expect(nextAcknowledged(ack(), status({ a: { work: 'idle' } }), 'a')).toBeNull()
  })

  it('does not acknowledge a session you are not viewing', () => {
    expect(nextAcknowledged(ack(), status({ a: { attention: 'input' } }), null)).toBeNull()
    expect(nextAcknowledged(ack(), status({ a: { attention: 'input' } }), 'b')).toBeNull()
  })

  it('is identity-stable once nothing changes', () => {
    const live = status({ a: { attention: 'input' } })
    expect(nextAcknowledged(ack(['a']), live, 'a')).toBeNull()
  })

  it('releases the mark when the agent takes another turn', () => {
    const next = nextAcknowledged(ack(['a']), status({ a: { work: 'working', attention: 'input' } }), null)
    expect(next && [...next]).toEqual([])
  })

  it('releases the mark when the desktop drops the signal itself', () => {
    const next = nextAcknowledged(ack(['a']), status({ a: { work: 'idle' } }), null)
    expect(next && [...next]).toEqual([])
  })

  it('releases the mark for a session that vanished from the mirror', () => {
    const next = nextAcknowledged(ack(['a']), status({}), null)
    expect(next && [...next]).toEqual([])
  })

  it('re-lights a question asked after a new turn, even while still viewing', () => {
    // Working releases the ack…
    const working = nextAcknowledged(ack(['a']), status({ a: { work: 'working', attention: 'input' } }), 'a')
    expect(working && [...working]).toEqual([])
    // …and the next ask is only re-acknowledged by looking at it again.
    const asked = nextAcknowledged(ack(), status({ a: { work: 'idle', attention: 'input' } }), null)
    expect(asked).toBeNull()
  })
})

describe('applyAttentionAck', () => {
  it('returns the same object when nothing is acknowledged', () => {
    const live = status({ a: { attention: 'input' } })
    expect(applyAttentionAck(live, ack())).toBe(live)
    expect(applyAttentionAck(live, ack(['b']))).toBe(live)
  })

  it('strips only the acknowledged asks, keeping everything else intact', () => {
    const live = status({
      a: { work: 'idle', attention: 'input' },
      b: { work: 'idle', attention: 'input' },
    })
    const out = applyAttentionAck(live, ack(['a']))
    expect(out.a).toEqual({ work: 'idle', attention: undefined })
    expect(out.b).toEqual({ work: 'idle', attention: 'input' })
    expect(live.a.attention).toBe('input')
  })
})
