import { describe, it, expect } from 'vitest'
import { buildLiveStatus } from './remote-bridge-livestatus'

describe('buildLiveStatus', () => {
  it('shimmers a working session the daemon tap never caught (the bug)', () => {
    // Session is working per the renderer but absent from the sparse tap.
    const out = buildLiveStatus(['s1'], {}, { s1: 'working' })
    expect(out.s1).toEqual({ work: 'working' })
  })

  it('emits an entry for every live session, defaulting to idle', () => {
    const out = buildLiveStatus(['a', 'b'], {}, {})
    expect(out).toEqual({ a: { work: 'idle' }, b: { work: 'idle' } })
  })

  it('lets renderer work override a stale tap value', () => {
    const out = buildLiveStatus(['s1'], { s1: { work: 'working' } }, { s1: 'idle' })
    expect(out.s1.work).toBe('idle')
  })

  it('preserves the tap exited/label flags (exited must not shimmer)', () => {
    const out = buildLiveStatus(
      ['s1'],
      { s1: { work: 'idle', exited: true, label: 'B' } },
      { s1: 'working' },
    )
    // work reflects the renderer, but exited is kept so the web (work==='working'
    // && !exited) does not shimmer an exited session.
    expect(out.s1).toEqual({ work: 'working', exited: true, label: 'B' })
  })

  it('drops sessions no longer present (not in sessionIds)', () => {
    const out = buildLiveStatus(['s1'], { gone: { work: 'working' } }, { gone: 'working' })
    expect(out).toEqual({ s1: { work: 'idle' } })
  })

  it('falls back to the tap work when the renderer has no entry', () => {
    const out = buildLiveStatus(['s1'], { s1: { work: 'working' } }, {})
    expect(out.s1.work).toBe('working')
  })
})
