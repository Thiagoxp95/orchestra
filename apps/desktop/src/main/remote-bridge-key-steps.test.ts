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
