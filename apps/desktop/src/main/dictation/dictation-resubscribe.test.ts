import { beforeEach, describe, expect, it, vi } from 'vitest'

// Regression coverage for "hold to talk hangs, then says the desktop isn't
// running" while the mirror stays perfectly live.
//
// Root cause: pendingDictation is the ONLY thing that tells the desktop an
// utterance exists, and it rides the remote bridge's Convex client. The bridge
// defends its own command loop against that client dying or wedging — it rebuilds
// the client on a push stall (recreateClient closes the old one, killing every
// subscription on it) and re-opens the command subscription on a timer, on focus
// and on wake. The dictation subscription subscribed exactly once at startup and
// was never re-opened, so the first client rebuild left it deaf for the rest of
// the run. The phone then recorded, uploaded its audio, and waited out its own
// 60s timeout while the desktop — mirror healthy, commands flowing, Parakeet warm
// — never learned there was anything to transcribe.
//
// The invariant locked in here: the orchestrator registers with the bridge, and
// every bridge refresh re-opens pendingDictation against the CURRENT client,
// disposing the previous handle first (a leak would double-feed the model).

const unsubscribes: Array<ReturnType<typeof vi.fn>> = []
const onUpdate = vi.fn(() => {
  const unsub = vi.fn()
  unsubscribes.push(unsub)
  return unsub
})
// Rebuilding the bridge's client hands back a different object; the assertions
// below check the re-subscribe actually targets the new one.
let currentClient = { onUpdate, mutation: vi.fn(), query: vi.fn(async () => []) }
const refreshers: Array<() => void> = []

vi.mock('../remote-bridge', () => ({
  getRemoteClient: () => currentClient,
  remoteTerminalInputGuard: () => () => {},
  isRemoteBridgeEnabled: () => true,
  registerRemoteSubscription: (refresh: () => void) => {
    refreshers.push(refresh)
    return () => {
      const i = refreshers.indexOf(refresh)
      if (i >= 0) refreshers.splice(i, 1)
    }
  },
}))
vi.mock('../daemon-client', () => ({ getDaemonClient: () => ({ write: vi.fn() }) }))
vi.mock('../convex-config', () => ({ DEVICE_SECRET: 'test-secret' }))
vi.mock('./dictation-sidecar', () => ({
  spawnDictationSidecar: () => ({
    onEvent: vi.fn(),
    onExit: vi.fn(),
    onStderr: vi.fn(),
    sendAudio: vi.fn(),
    end: vi.fn(),
    reset: vi.fn(),
    shutdown: vi.fn(),
    kill: vi.fn(),
  }),
}))

const { startDictationOrchestrator, stopDictationOrchestrator } = await import(
  './dictation-orchestrator'
)

/** The client the Nth pendingDictation subscription was opened against. */
const clientOfCall = (n: number): unknown => onUpdate.mock.instances[n]

describe('dictation pendingDictation subscription liveness', () => {
  beforeEach(() => {
    stopDictationOrchestrator()
    onUpdate.mockClear()
    unsubscribes.length = 0
    refreshers.length = 0
    currentClient = { onUpdate, mutation: vi.fn(), query: vi.fn(async () => []) }
  })

  it('registers with the bridge so the subscription is refreshed, not just opened once', () => {
    startDictationOrchestrator()
    expect(refreshers).toHaveLength(1)
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('re-opens against the new client after the bridge rebuilds it', () => {
    startDictationOrchestrator()
    const dead = currentClient

    // What recreateClient() does: the old client is closed (its subscriptions are
    // gone), a fresh one takes its place, then the refresh beat fires.
    currentClient = { onUpdate, mutation: vi.fn(), query: vi.fn(async () => []) }
    refreshers.forEach((r) => r())

    expect(onUpdate).toHaveBeenCalledTimes(2)
    expect(clientOfCall(1)).toBe(currentClient)
    expect(clientOfCall(1)).not.toBe(dead)
  })

  it('disposes the previous handle on every refresh, so subscriptions never stack', () => {
    startDictationOrchestrator()
    for (let i = 0; i < 3; i++) refreshers.forEach((r) => r())

    expect(onUpdate).toHaveBeenCalledTimes(4)
    // Every handle but the newest has been unsubscribed. Leaking one would
    // deliver each pending row twice and transcribe the utterance twice over.
    expect(unsubscribes.slice(0, -1).every((u) => u.mock.calls.length === 1)).toBe(true)
    expect(unsubscribes.at(-1)).not.toHaveBeenCalled()
  })

  it('stops refreshing once the orchestrator is torn down', () => {
    startDictationOrchestrator()
    stopDictationOrchestrator()
    const afterStop = onUpdate.mock.calls.length

    // A late bridge beat must not resurrect the subscription we just stopped.
    refreshers.forEach((r) => r())
    expect(refreshers).toHaveLength(0)
    expect(onUpdate).toHaveBeenCalledTimes(afterStop)
  })
})
