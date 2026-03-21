import { describe, expect, it, vi } from 'vitest'
import {
  countWarmShellCapacity,
  getAdaptiveWarmShellPoolSize,
  pickWarmShellForClaim,
  pruneWarmShellPool,
  shouldReuseWarmShell,
  trimBurstClaimTimestamps,
  DEFAULT_WARM_SHELL_POOL_SIZE,
  MAX_WARM_SHELL_POOL_SIZE,
  WARM_SHELL_BURST_WINDOW_MS,
  WARM_SHELL_IDLE_TTL_MS,
} from './warm-shell-pool'

describe('shouldReuseWarmShell', () => {
  it('reuses shell-backed sessions even when a command will be sent later', () => {
    expect(shouldReuseWarmShell(undefined)).toBe(true)
    expect(shouldReuseWarmShell({ kind: 'shell' })).toBe(true)
  })

  it('does not reuse direct exec launches', () => {
    expect(shouldReuseWarmShell({ kind: 'exec', file: 'claude' })).toBe(false)
  })
})

describe('pruneWarmShellPool', () => {
  it('keeps attachable shells and disposes dead ones', () => {
    const disposeAlive = vi.fn()
    const disposeDead = vi.fn()

    const active = pruneWarmShellPool([
      { isAttachable: true, isReadyForReuse: false, dispose: disposeAlive },
      { isAttachable: false, isReadyForReuse: false, dispose: disposeDead },
    ])

    expect(active).toHaveLength(1)
    expect(disposeAlive).not.toHaveBeenCalled()
    expect(disposeDead).toHaveBeenCalledOnce()
  })
})

describe('pickWarmShellForClaim', () => {
  it('prefers a fully ready warm shell', () => {
    expect(pickWarmShellForClaim([
      { isAttachable: true, isReadyForReuse: false, dispose: vi.fn() },
      { isAttachable: true, isReadyForReuse: true, dispose: vi.fn() },
    ])).toBe(1)
  })

  it('falls back to an attachable warming shell when no shell is fully ready yet', () => {
    expect(pickWarmShellForClaim([
      { isAttachable: true, isReadyForReuse: false, dispose: vi.fn() },
      { isAttachable: false, isReadyForReuse: true, dispose: vi.fn() },
    ])).toBe(0)
  })
})

describe('countWarmShellCapacity', () => {
  it('counts both ready and still-warming attachable shells toward pool capacity', () => {
    expect(countWarmShellCapacity([
      { isAttachable: true, isReadyForReuse: true, dispose: vi.fn() },
      { isAttachable: true, isReadyForReuse: false, dispose: vi.fn() },
      { isAttachable: false, isReadyForReuse: false, dispose: vi.fn() },
    ])).toBe(2)
  })
})

describe('trimBurstClaimTimestamps', () => {
  it('drops claims outside the burst window', () => {
    expect(
      trimBurstClaimTimestamps(
        [0, 1, WARM_SHELL_BURST_WINDOW_MS + 1],
        WARM_SHELL_BURST_WINDOW_MS + 1,
      )
    ).toEqual([WARM_SHELL_BURST_WINDOW_MS + 1])
  })
})

describe('getAdaptiveWarmShellPoolSize', () => {
  it('keeps the steady-state base size when there is no burst activity', () => {
    expect(getAdaptiveWarmShellPoolSize([], 0)).toBe(DEFAULT_WARM_SHELL_POOL_SIZE)
  })

  it('grows with recent claims and caps at the configured maximum', () => {
    const claims = Array.from({ length: MAX_WARM_SHELL_POOL_SIZE + 5 }, (_, index) => index)
    expect(getAdaptiveWarmShellPoolSize(claims, MAX_WARM_SHELL_POOL_SIZE + 5)).toBe(MAX_WARM_SHELL_POOL_SIZE)
  })

  it('shrinks back toward the base size after the burst window expires', () => {
    const now = WARM_SHELL_BURST_WINDOW_MS + 10
    expect(getAdaptiveWarmShellPoolSize([0, now - 1], now)).toBe(DEFAULT_WARM_SHELL_POOL_SIZE + 1)
  })
})

describe('warm shell idle ttl', () => {
  it('expires unused warm shell pools after five minutes', () => {
    expect(WARM_SHELL_IDLE_TTL_MS).toBe(5 * 60_000)
  })
})
