import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let idleSeconds = 0
let bridgeEnabled = false
// Typed args: the assertions read the notification body back off the calls, and
// an untyped vi.fn() infers a zero-length tuple that `calls[n][0]` can't index.
const sendPushNotification = vi.fn((_args: { body: string }) => Promise.resolve())

vi.mock('electron', () => ({ powerMonitor: { getSystemIdleTime: () => idleSeconds } }))
vi.mock('./remote-bridge', () => ({
  isRemoteBridgeEnabled: () => bridgeEnabled,
}))
vi.mock('./local-server/push', () => ({ sendPushNotification: (args: { body: string }) => sendPushNotification(args) }))

import {
  shouldRemoteNotify,
  resolveNotifyVerdict,
  resolveNotifyBody,
  remoteBridgeNotify,
  noteRemoteBridgeWorking,
  forgetRemoteBridgeNotify,
  setRemoteNotifyStatusResolver,
  IDLE_THRESHOLD_SECONDS,
  NOTIFY_SETTLE_MS,
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

describe('remoteBridgeNotify', () => {
  const SESSION = 'session-a'
  const claim = (requiresUserInput: boolean) => ({
    sessionId: SESSION,
    title: 'Jack sidebar',
    body: requiresUserInput ? 'Needs your input' : 'Finished',
    requiresUserInput,
  })
  const sentBodies = () => sendPushNotification.mock.calls.map((c) => c[0].body)

  beforeEach(() => {
    vi.useFakeTimers()
    sendPushNotification.mockClear()
    bridgeEnabled = true
    idleSeconds = IDLE_THRESHOLD_SECONDS
    setRemoteNotifyStatusResolver(() => 'idle')
    forgetRemoteBridgeNotify(SESSION)
  })
  afterEach(() => {
    vi.useRealTimers()
    setRemoteNotifyStatusResolver(null)
    bridgeEnabled = false
  })

  it('drops the push when the agent is still working once it settles', () => {
    // The screenshot case: a "needs input" push landing while the phone's own
    // chat renders "Working for 13s".
    setRemoteNotifyStatusResolver(() => 'working')
    remoteBridgeNotify(claim(true))
    vi.advanceTimersByTime(NOTIFY_SETTLE_MS)
    expect(sendPushNotification).not.toHaveBeenCalled()
  })

  it('sends once the claim survives the settle window', () => {
    setRemoteNotifyStatusResolver(() => 'waitingUserInput')
    remoteBridgeNotify(claim(true))
    expect(sendPushNotification).not.toHaveBeenCalled() // nothing goes out immediately
    vi.advanceTimersByTime(NOTIFY_SETTLE_MS)
    expect(sentBodies()).toEqual(['Needs your input'])
  })

  it('re-words a needs-input claim the agent has moved past', () => {
    remoteBridgeNotify(claim(true)) // resolver says idle
    vi.advanceTimersByTime(NOTIFY_SETTLE_MS)
    expect(sentBodies()).toEqual(['Finished'])
  })

  it('coalesces a burst of claims into the newest one', () => {
    setRemoteNotifyStatusResolver(() => 'waitingUserInput')
    remoteBridgeNotify(claim(false))
    vi.advanceTimersByTime(NOTIFY_SETTLE_MS / 2)
    remoteBridgeNotify(claim(true))
    vi.advanceTimersByTime(NOTIFY_SETTLE_MS)
    expect(sendPushNotification).toHaveBeenCalledTimes(1)
  })

  it('does not re-notify the same state until the agent takes a turn', () => {
    setRemoteNotifyStatusResolver(() => 'waitingUserInput')
    remoteBridgeNotify(claim(true))
    vi.advanceTimersByTime(NOTIFY_SETTLE_MS)
    remoteBridgeNotify(claim(true))
    vi.advanceTimersByTime(NOTIFY_SETTLE_MS)
    expect(sendPushNotification).toHaveBeenCalledTimes(1)

    noteRemoteBridgeWorking(SESSION) // new turn ⇒ the next ask is a new ask
    remoteBridgeNotify(claim(true))
    vi.advanceTimersByTime(NOTIFY_SETTLE_MS)
    expect(sendPushNotification).toHaveBeenCalledTimes(2)
  })

  it('checks the Mac-idle gate at send time, not at queue time', () => {
    idleSeconds = 0 // user at the Mac when the agent stopped
    remoteBridgeNotify(claim(false))
    idleSeconds = IDLE_THRESHOLD_SECONDS // walked away during the settle window
    vi.advanceTimersByTime(NOTIFY_SETTLE_MS)
    expect(sendPushNotification).toHaveBeenCalledTimes(1)
  })

  it('drops a pending push when the agent resumes', () => {
    remoteBridgeNotify(claim(false))
    noteRemoteBridgeWorking(SESSION)
    vi.advanceTimersByTime(NOTIFY_SETTLE_MS)
    expect(sendPushNotification).not.toHaveBeenCalled()
  })
})
