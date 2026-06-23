import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ powerMonitor: { getSystemIdleTime: () => 0 } }))
vi.mock('./remote-bridge', () => ({
  isRemoteBridgeEnabled: vi.fn(() => false),
  getRemoteClient: vi.fn(),
}))
vi.mock('./convex-config', () => ({ DEVICE_SECRET: undefined, CONVEX_CLOUD_URL: '' }))

import { shouldRemoteNotify, IDLE_THRESHOLD_SECONDS } from './remote-bridge-notify'

describe('shouldRemoteNotify', () => {
  it('pushes when idle at or above the threshold', () => {
    expect(shouldRemoteNotify(IDLE_THRESHOLD_SECONDS, IDLE_THRESHOLD_SECONDS)).toBe(true)
    expect(shouldRemoteNotify(IDLE_THRESHOLD_SECONDS + 10, IDLE_THRESHOLD_SECONDS)).toBe(true)
  })
  it('suppresses when idle below the threshold', () => {
    expect(shouldRemoteNotify(0, IDLE_THRESHOLD_SECONDS)).toBe(false)
    expect(shouldRemoteNotify(IDLE_THRESHOLD_SECONDS - 1, IDLE_THRESHOLD_SECONDS)).toBe(false)
  })
})
