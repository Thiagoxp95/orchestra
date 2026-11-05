import { afterEach, describe, expect, it, vi } from 'vitest'
import { SyncHub } from './sync-hub'
import * as state from './runtime-state'

const snapshot = {
  workspaces: [],
  sessions: { a: { label: 'one' } },
  liveStatus: {},
  activeWorkspaceId: null,
  activeSessionId: null,
  geometryOwner: 'desktop' as const,
  geometryEpoch: 0,
}

describe('remote state mirror', () => {
  afterEach(() => {
    state.clearRemoteState()
    state.setInvalidator(() => {})
    vi.useRealTimers()
  })

  it('sends a phone nothing when the desktop republishes unchanged state', async () => {
    vi.useFakeTimers()
    const hub = new SyncHub()
    hub.query('remote.getRemoteState', () => state.getRemoteState())
    state.setInvalidator((...names) => hub.invalidate(...names))
    const sent: string[] = []
    const phone = { value: (_id: number, _v: unknown, encoded: string) => sent.push(encoded), error: () => {} }
    hub.connect(phone)

    state.setRemoteState(snapshot)
    hub.subscribe(phone, 1, 'remote.getRemoteState', {})
    await vi.runAllTimersAsync()
    for (let i = 0; i < 50; i++) {
      vi.advanceTimersByTime(200)
      state.setRemoteState({ ...snapshot })
      await vi.runAllTimersAsync()
    }
    expect(sent).toHaveLength(1)

    state.setRemoteState({ ...snapshot, activeSessionId: 'a' })
    await vi.runAllTimersAsync()
    expect(sent).toHaveLength(2)
  })
})
