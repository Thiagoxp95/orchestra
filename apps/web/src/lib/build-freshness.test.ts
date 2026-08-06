import { describe, it, expect, vi } from 'vitest'
import {
  isValidBuildId,
  shouldReload,
  checkBuildFreshness,
  RELOAD_THROTTLE_MS,
} from './build-freshness'

describe('isValidBuildId', () => {
  it('accepts base36 ids', () => {
    expect(isValidBuildId('mdyq1x2z')).toBe(true)
  })

  it('rejects an HTML error page and the empty string', () => {
    expect(isValidBuildId('<!doctype html>')).toBe(false)
    expect(isValidBuildId('')).toBe(false)
  })
})

describe('shouldReload', () => {
  const NOW = 1_000_000

  it('reloads when the server runs a different build', () => {
    expect(shouldReload('aaa', 'bbb', null, NOW)).toBe(true)
  })

  it('stays put when the build matches', () => {
    expect(shouldReload('aaa', 'aaa', null, NOW)).toBe(false)
  })

  it('never reloads a dev/unknown bundle', () => {
    expect(shouldReload(undefined, 'bbb', null, NOW)).toBe(false)
    expect(shouldReload('', 'bbb', null, NOW)).toBe(false)
  })

  it('never reloads on a garbage server answer', () => {
    expect(shouldReload('aaa', '<!doctype html>', null, NOW)).toBe(false)
  })

  it('throttles repeat reloads inside the window, allows them after', () => {
    expect(shouldReload('aaa', 'bbb', NOW - RELOAD_THROTTLE_MS + 1, NOW)).toBe(false)
    expect(shouldReload('aaa', 'bbb', NOW - RELOAD_THROTTLE_MS, NOW)).toBe(true)
  })
})

describe('checkBuildFreshness', () => {
  function deps(overrides: Partial<Parameters<typeof checkBuildFreshness>[0]> = {}) {
    return {
      runningId: 'aaa',
      fetchServerId: async () => 'bbb',
      getLastReloadAt: () => null,
      setLastReloadAt: vi.fn(),
      reload: vi.fn(),
      now: () => 1_000_000,
      ...overrides,
    }
  }

  it('reloads and stamps when the server moved ahead', async () => {
    const d = deps()
    await expect(checkBuildFreshness(d)).resolves.toBe(true)
    expect(d.reload).toHaveBeenCalledTimes(1)
    expect(d.setLastReloadAt).toHaveBeenCalledWith(1_000_000)
  })

  it('trims the response before comparing', async () => {
    const d = deps({ fetchServerId: async () => 'aaa\n' })
    await expect(checkBuildFreshness(d)).resolves.toBe(false)
    expect(d.reload).not.toHaveBeenCalled()
  })

  it('treats a network failure as not-stale', async () => {
    const d = deps({
      fetchServerId: async () => {
        throw new Error('offline')
      },
    })
    await expect(checkBuildFreshness(d)).resolves.toBe(false)
    expect(d.reload).not.toHaveBeenCalled()
  })

  it('respects the reload throttle stamp', async () => {
    const d = deps({ getLastReloadAt: () => 1_000_000 - 1 })
    await expect(checkBuildFreshness(d)).resolves.toBe(false)
    expect(d.reload).not.toHaveBeenCalled()
  })
})
