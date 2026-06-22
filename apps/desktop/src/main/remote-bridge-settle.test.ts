import { describe, expect, it } from 'vitest'
import { snapshotWhenSettled } from './remote-bridge-snapshot'
import type { SessionSnapshot } from '../daemon/protocol'

const snap = (ansi: string): SessionSnapshot => ({
  snapshotAnsi: ansi,
  rehydrateSequences: '',
  cwd: '/',
  cols: 80,
  rows: 24,
})

// Deterministic fake clock: `delay` advances virtual time so the suite is
// instant, and `getSnapshot` returns successive frames mimicking the mirror's
// post-resize redraw (garbage → mid-reflow → settled).
function harness(frames: string[]) {
  let t = 0
  let i = 0
  return {
    now: () => t,
    delay: async (ms: number) => {
      t += ms
    },
    getSnapshot: async () => snap(frames[Math.min(i++, frames.length - 1)]),
  }
}

const OPTS = { minSettleMs: 150, intervalMs: 70, timeoutMs: 800 }

describe('snapshotWhenSettled', () => {
  it('waits past the mid-reflow garbage and returns the settled frame', async () => {
    const h = harness(['GARBAGE', 'MIDRAW', 'CLEAN', 'CLEAN', 'CLEAN'])
    const out = await snapshotWhenSettled(h.getSnapshot, { ...OPTS, now: h.now, delay: h.delay })
    expect(out?.snapshotAnsi).toBe('CLEAN')
  })

  it('does not accept an early-stable garbage frame before minSettleMs', async () => {
    // First two reads are identical (redraw not started yet) — must keep waiting
    // until the real redraw lands rather than seeding the stale frame.
    const h = harness(['GARB', 'GARB', 'CLEAN', 'CLEAN'])
    const out = await snapshotWhenSettled(h.getSnapshot, { ...OPTS, now: h.now, delay: h.delay })
    expect(out?.snapshotAnsi).toBe('CLEAN')
  })

  it('returns the most recent frame if the screen never settles before timeout', async () => {
    const h = harness(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'])
    const out = await snapshotWhenSettled(h.getSnapshot, {
      ...OPTS,
      timeoutMs: 300,
      now: h.now,
      delay: h.delay,
    })
    expect(out).not.toBeNull()
  })
})
