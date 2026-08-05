import { describe, expect, it } from 'vitest'
import {
  MAX_KEY_STEPS,
  MAX_STEP_DELAY_MS,
  runKeySteps,
  sanitizeKeySteps,
  type KeyStepDeps,
} from './remote-bridge-key-steps'

/** Virtual clock: writes are logged with the time they happen. */
function makeDeps() {
  const log: { at: number; data: string }[] = []
  let clock = 0
  const deps: KeyStepDeps = {
    write: (data) => log.push({ at: clock, data }),
    sleep: (ms) => {
      clock += ms
      return Promise.resolve()
    },
  }
  return { deps, log }
}

describe('sanitizeKeySteps', () => {
  it('accepts a real claude model-switch sequence', () => {
    const steps = sanitizeKeySteps([
      { data: '\x15', delayAfterMs: 120 },
      { data: '/model opus', delayAfterMs: 350 },
      { data: '\r', delayAfterMs: 600 },
    ])
    expect(steps).toHaveLength(3)
    expect(steps?.[1]).toEqual({ data: '/model opus', delayAfterMs: 350 })
  })

  it('rejects non-arrays, empty arrays, and oversized payloads', () => {
    expect(sanitizeKeySteps(undefined)).toBeNull()
    expect(sanitizeKeySteps('\r')).toBeNull()
    expect(sanitizeKeySteps([])).toBeNull()
    expect(
      sanitizeKeySteps(Array.from({ length: MAX_KEY_STEPS + 1 }, () => ({ data: 'x', delayAfterMs: 0 }))),
    ).toBeNull()
  })

  it('rejects malformed steps rather than skipping them (a half sequence is worse than none)', () => {
    expect(sanitizeKeySteps([{ data: '\x15', delayAfterMs: 100 }, { data: 42 }])).toBeNull()
    expect(sanitizeKeySteps([{ data: '', delayAfterMs: 100 }])).toBeNull()
    expect(sanitizeKeySteps([{ data: 'x'.repeat(500), delayAfterMs: 0 }])).toBeNull()
  })

  it('clamps absurd delays and defaults missing ones to 0', () => {
    const steps = sanitizeKeySteps([
      { data: 'a', delayAfterMs: 999_999 },
      { data: 'b', delayAfterMs: -5 },
      { data: 'c' },
    ])
    expect(steps?.map((s) => s.delayAfterMs)).toEqual([MAX_STEP_DELAY_MS, 0, 0])
  })
})

describe('conditional steps (TUI confirmation dialogs)', () => {
  const effortSequence = [
    { data: '\x15', delayAfterMs: 120 },
    { data: '/effort high', delayAfterMs: 350 },
    { data: '\r', delayAfterMs: 600 },
    { data: '1', delayAfterMs: 250, ifScreenContains: 'Change effort level?' },
    { data: '\r', delayAfterMs: 600, ifScreenContains: 'Change effort level?' },
  ]

  it('sends the confirmation when the dialog is on screen', async () => {
    const { deps, log } = makeDeps()
    await runKeySteps(
      { ...deps, readScreen: () => 'Change effort level?\n 1. Yes, switch to high\n 2. No, go back' },
      effortSequence,
    )
    expect(log.map((l) => l.data)).toEqual(['\x15', '/effort high', '\r', '1', '\r'])
  })

  it('skips it (and its delay) when no dialog appeared — a stray "1" would be sent to the agent', async () => {
    const { deps, log } = makeDeps()
    await runKeySteps({ ...deps, readScreen: () => 'Effort set to high' }, effortSequence)
    expect(log.map((l) => l.data)).toEqual(['\x15', '/effort high', '\r'])
    expect(log[log.length - 1].at).toBe(470)
  })

  it('skips conditional steps when the host provides no screen reader at all', async () => {
    const { deps, log } = makeDeps()
    await runKeySteps(deps, effortSequence)
    expect(log.map((l) => l.data)).toEqual(['\x15', '/effort high', '\r'])
  })

  it('matches case-insensitively', async () => {
    const { deps, log } = makeDeps()
    await runKeySteps({ ...deps, readScreen: () => 'CHANGE EFFORT LEVEL?' }, effortSequence)
    expect(log).toHaveLength(5)
  })

  it('sanitize keeps a valid guard and rejects a malformed one', () => {
    expect(sanitizeKeySteps([{ data: '1', delayAfterMs: 0, ifScreenContains: 'Change effort level?' }])?.[0]).toEqual({
      data: '1',
      delayAfterMs: 0,
      ifScreenContains: 'Change effort level?',
    })
    expect(sanitizeKeySteps([{ data: '1', delayAfterMs: 0, ifScreenContains: '' }])).toBeNull()
    expect(sanitizeKeySteps([{ data: '1', delayAfterMs: 0, ifScreenContains: 42 }])).toBeNull()
    expect(sanitizeKeySteps([{ data: '1', delayAfterMs: 0, ifScreenContains: 'x'.repeat(200) }])).toBeNull()
  })
})

describe('runKeySteps', () => {
  it('writes each step and honors its trailing delay at the PTY', async () => {
    const { deps, log } = makeDeps()
    await runKeySteps(deps, [
      { data: '\x15', delayAfterMs: 120 },
      { data: '/effort high', delayAfterMs: 350 },
      { data: '\r', delayAfterMs: 600 },
    ])
    expect(log).toEqual([
      { at: 0, data: '\x15' },
      { at: 120, data: '/effort high' },
      { at: 470, data: '\r' },
    ])
  })

  it('skips the sleep for zero delays', async () => {
    const { deps, log } = makeDeps()
    await runKeySteps(deps, [
      { data: '1', delayAfterMs: 0 },
      { data: '\r', delayAfterMs: 0 },
    ])
    expect(log.map((l) => l.at)).toEqual([0, 0])
  })
})
