import { describe, it, expect } from 'vitest'
import {
  initialOwnership,
  claimWeb,
  reclaimDesktop,
  overlaySessionGeometry,
  type GeometryOwnership,
} from './remote-bridge-geometry'

describe('geometry ownership reducer', () => {
  it('starts owned by the desktop with no web geometry', () => {
    const s = initialOwnership()
    expect(s).toEqual({ owner: 'desktop', webGeometry: null, epoch: 0 })
  })

  describe('claimWeb', () => {
    it('flips desktop → web, records geometry, and bumps the epoch', () => {
      const { state, changed } = claimWeb(initialOwnership(), 50, 40)
      expect(changed).toBe(true)
      expect(state).toEqual({ owner: 'web', webGeometry: { cols: 50, rows: 40 }, epoch: 1 })
    })

    it('is a no-op when the web already owns exactly that geometry (idempotent focus/resize claims)', () => {
      const first = claimWeb(initialOwnership(), 50, 40).state
      const { state, changed } = claimWeb(first, 50, 40)
      expect(changed).toBe(false)
      expect(state).toBe(first) // same reference — no epoch churn
    })

    it('re-claims (bumps epoch) when the web geometry changes', () => {
      const first = claimWeb(initialOwnership(), 50, 40).state
      const { state, changed } = claimWeb(first, 60, 30)
      expect(changed).toBe(true)
      expect(state).toEqual({ owner: 'web', webGeometry: { cols: 60, rows: 30 }, epoch: 2 })
    })

    it('rejects garbage dimensions without changing ownership', () => {
      for (const [c, r] of [[0, 24], [80, -1], [NaN, 24], [80, Infinity]] as const) {
        const { state, changed } = claimWeb(initialOwnership(), c, r)
        expect(changed).toBe(false)
        expect(state.owner).toBe('desktop')
      }
    })
  })

  describe('reclaimDesktop', () => {
    it('flips web → desktop, clears web geometry, and bumps the epoch', () => {
      const webOwned = claimWeb(initialOwnership(), 50, 40).state
      const { state, changed } = reclaimDesktop(webOwned)
      expect(changed).toBe(true)
      expect(state).toEqual({ owner: 'desktop', webGeometry: null, epoch: 2 })
    })

    it('is a no-op when the desktop already owns', () => {
      const s = initialOwnership()
      const { state, changed } = reclaimDesktop(s)
      expect(changed).toBe(false)
      expect(state).toBe(s)
    })

    it('a full handoff cycle keeps bumping the epoch monotonically', () => {
      let s: GeometryOwnership = initialOwnership()
      s = claimWeb(s, 50, 40).state
      s = reclaimDesktop(s).state
      s = claimWeb(s, 50, 40).state
      expect(s.epoch).toBe(3)
      expect(s.owner).toBe('web')
    })
  })

  describe('overlaySessionGeometry', () => {
    it('forces EVERY session to the phone viewport when the web owns', () => {
      const sessions: Record<string, { cols?: number; rows?: number }> = {
        a: { cols: 200, rows: 50 },
        b: {},
      }
      overlaySessionGeometry(sessions, claimWeb(initialOwnership(), 50, 40).state, {})
      expect(sessions.a).toEqual({ cols: 50, rows: 40 })
      expect(sessions.b).toEqual({ cols: 50, rows: 40 })
    })

    it('applies per-session desktop live geometry when the desktop owns', () => {
      const sessions: Record<string, { cols?: number; rows?: number }> = { a: {}, b: {} }
      overlaySessionGeometry(sessions, initialOwnership(), { a: { cols: 180, rows: 48 } })
      expect(sessions.a).toEqual({ cols: 180, rows: 48 })
      expect(sessions.b).toEqual({}) // no live geometry recorded → untouched
    })
  })
})
