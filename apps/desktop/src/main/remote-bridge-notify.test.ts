import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ powerMonitor: { getSystemIdleTime: () => 0 } }))
vi.mock('./remote-bridge', () => ({
  isRemoteBridgeEnabled: vi.fn(() => false),
  getRemoteClient: vi.fn(),
}))
vi.mock('./convex-config', () => ({ DEVICE_SECRET: undefined, CONVEX_CLOUD_URL: '' }))

import {
  shouldRemoteNotify,
  resolveNotifyVerdict,
  resolveNotifyBody,
  IDLE_THRESHOLD_SECONDS,
} from './remote-bridge-notify'

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

describe('resolveNotifyVerdict', () => {
  it('drops a claim the agent has already moved past', () => {
    // The OSC-title blip that fired this is over — the agent never stopped.
    expect(resolveNotifyVerdict(false, 'working')).toEqual({ send: false, reason: 'working' })
    expect(resolveNotifyVerdict(true, 'working')).toEqual({ send: false, reason: 'working' })
  })

  it('re-derives the wording from the current state, not the claim', () => {
    expect(resolveNotifyVerdict(false, 'waitingUserInput')).toEqual({ send: true, requiresUserInput: true })
    expect(resolveNotifyVerdict(false, 'waitingApproval')).toEqual({ send: true, requiresUserInput: true })
    expect(resolveNotifyVerdict(true, 'idle')).toEqual({ send: true, requiresUserInput: false })
  })

  it('passes the claim through when the state is unknown', () => {
    // Losing a real notification is worse than shipping a stale one.
    expect(resolveNotifyVerdict(true, null)).toEqual({ send: true, requiresUserInput: true })
    expect(resolveNotifyVerdict(false, 'unknown')).toEqual({ send: true, requiresUserInput: false })
    expect(resolveNotifyVerdict(true, 'error')).toEqual({ send: true, requiresUserInput: true })
  })
})

describe('resolveNotifyBody', () => {
  it('swaps the generic wording when the verdict re-classified', () => {
    expect(resolveNotifyBody('Needs your input', false)).toBe('Finished')
    expect(resolveNotifyBody('Finished', true)).toBe('Needs your input')
  })

  it('leaves a descriptive body alone', () => {
    expect(resolveNotifyBody('Allow Bash(rm -rf)?', false)).toBe('Allow Bash(rm -rf)?')
  })
})
