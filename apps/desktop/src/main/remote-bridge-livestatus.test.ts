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

  it('carries the context window figures for the phone overview', () => {
    const out = buildLiveStatus(
      ['s1'],
      {},
      { s1: 'working' },
      {},
      { s1: { usedTokens: 98_883, contextWindow: 200_000, updatedAt: 1_700 } },
    )
    expect(out.s1).toEqual({
      work: 'working',
      contextTokens: 98_883,
      contextWindow: 200_000,
      activeAt: 1_700,
    })
  })

  it('carries the current model and effort for the phone picker', () => {
    const out = buildLiveStatus(
      ['s1'],
      {},
      {},
      {},
      {
        s1: {
          usedTokens: 10,
          contextWindow: 200_000,
          updatedAt: 1_700,
          model: 'claude-fable-5',
          effort: 'xhigh',
        },
      },
    )
    expect(out.s1.model).toBe('claude-fable-5')
    expect(out.s1.effort).toBe('xhigh')
  })

  it('leaves a shell without context figures', () => {
    const out = buildLiveStatus(['shell'], {}, {}, {}, {}, { shell: 900 })
    expect(out.shell).toEqual({ work: 'idle', activeAt: 900 })
  })

  it('dates an agent by its transcript, never by terminal output', () => {
    // The bug: every PTY repaints when a phone claims geometry and resizes them
    // all, so `lastOutputAt` jumps to now for sessions the agent hasn't touched
    // in an hour. The transcript is the agent's own record — it wins even when
    // the terminal printed a second ago.
    const out = buildLiveStatus(
      ['s1'],
      {},
      {},
      {},
      { s1: { usedTokens: 10, contextWindow: 200_000, updatedAt: 1_000 } },
      { s1: 2_000 },
    )
    expect(out.s1.activeAt).toBe(1_000)
  })

  it('falls back to terminal output only when there is no transcript', () => {
    const out = buildLiveStatus(['s1'], {}, {}, {}, {}, { s1: 2_000 })
    expect(out.s1.activeAt).toBe(2_000)
  })

  it('omits activeAt entirely when neither clock has seen the session', () => {
    const out = buildLiveStatus(['s1'], {}, {})
    expect(out.s1).not.toHaveProperty('activeAt')
  })

  // The phone withholds its chat view on a false, and keeps it on a MISSING
  // field (a desktop too old to publish the flag) — so an agent whose
  // transcript hasn't paired must be stamped false out loud, and a shell must
  // carry nothing at all.
  it('publishes chat readiness for agents and says nothing about shells', () => {
    const out = buildLiveStatus(['agent', 'pending', 'shell'], {}, {}, {}, {}, {}, {
      agent: true,
      pending: false,
    })
    expect(out.agent.chatReady).toBe(true)
    expect(out.pending.chatReady).toBe(false)
    expect(out.shell).not.toHaveProperty('chatReady')
  })
})
