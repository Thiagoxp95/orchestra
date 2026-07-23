import { describe, expect, it } from 'vitest'
import { resolveAttachTarget, type PendingAttach } from './attach-target'

const sessions = {
  a1: { workspaceId: 'wsA' },
  b1: { workspaceId: 'wsB' },
}

const armed = (workspaceId: string | null): PendingAttach => ({
  workspaceId,
  known: Object.keys(sessions),
})

describe('resolveAttachTarget', () => {
  it('waits while nothing new has appeared in the target workspace', () => {
    // The desktop is still focused where it was — no jump, stay armed.
    expect(resolveAttachTarget(armed('wsB'), sessions, 'a1', 'wsA')).toBeNull()
  })

  it('attaches to the session spawned in the target workspace', () => {
    const next = { ...sessions, b2: { workspaceId: 'wsB' } }
    expect(resolveAttachTarget(armed('wsB'), next, 'b2', 'wsA')).toEqual({
      sessionId: 'b2',
      settled: true,
    })
  })

  it('ignores sessions that appear in other workspaces', () => {
    const next = { ...sessions, a2: { workspaceId: 'wsA' } }
    expect(resolveAttachTarget(armed('wsB'), next, 'a2', 'wsA')).toBeNull()
  })

  it('prefers the desktop-focused session when several are new', () => {
    const next = { ...sessions, b2: { workspaceId: 'wsB' }, b3: { workspaceId: 'wsB' } }
    expect(resolveAttachTarget(armed('wsB'), next, 'b2', 'wsA')).toEqual({
      sessionId: 'b2',
      settled: true,
    })
  })

  it('falls back to the newest when the desktop focus is elsewhere', () => {
    const next = { ...sessions, b2: { workspaceId: 'wsB' }, b3: { workspaceId: 'wsB' } }
    expect(resolveAttachTarget(armed('wsB'), next, 'a1', 'wsA')).toEqual({
      sessionId: 'b3',
      settled: true,
    })
  })

  it('follows the desktop into the target workspace unsettled, so the phone moves there first', () => {
    // The desktop switches workspace before it spawns, so its focus lands on a
    // session that was already in wsB. Go there, but keep waiting for the new one.
    expect(resolveAttachTarget(armed('wsB'), sessions, 'b1', 'wsA')).toEqual({
      sessionId: 'b1',
      settled: false,
    })
  })

  it('does not yank the user off their session when the action targets their own workspace', () => {
    expect(resolveAttachTarget(armed('wsA'), { ...sessions, a2: { workspaceId: 'wsA' } }, 'a2', 'wsA'))
      .toEqual({ sessionId: 'a2', settled: true })
    // …but until that new session exists, the desktop's focus must not move them.
    expect(resolveAttachTarget(armed('wsA'), sessions, 'a1', 'wsA')).toBeNull()
  })

  it('follows the desktop once when the target workspace is unknown', () => {
    expect(resolveAttachTarget(armed(null), sessions, 'b1', 'wsA')).toEqual({
      sessionId: 'b1',
      settled: true,
    })
    expect(resolveAttachTarget(armed(null), sessions, null, 'wsA')).toBeNull()
  })
})
