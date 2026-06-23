import { describe, it, expect, vi } from 'vitest'
import { resyncIfDisconnected } from './foreground-resync'

describe('resyncIfDisconnected', () => {
  it('dispatches a reconnect when the socket is disconnected', () => {
    const dispatchOnline = vi.fn()
    const acted = resyncIfDisconnected(() => false, dispatchOnline)
    expect(acted).toBe(true)
    expect(dispatchOnline).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the socket is already connected', () => {
    const dispatchOnline = vi.fn()
    const acted = resyncIfDisconnected(() => true, dispatchOnline)
    expect(acted).toBe(false)
    expect(dispatchOnline).not.toHaveBeenCalled()
  })
})
