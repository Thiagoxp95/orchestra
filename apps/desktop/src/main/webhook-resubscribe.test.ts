import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The webhook listener has the same single-subscription shape that left dictation
// deaf: everything it does hangs off one onUpdate, and a Convex socket can wedge
// "connected but no longer delivering". Nothing here would notice — webhooks would
// just stop firing, forever, with no error raised and no other symptom.
//
// These lock in the defense the remote bridge already ran for its command loop:
// re-open on a timer, always disposing the previous handle first, and stay stopped
// once stopped.

const unsubscribes: Array<ReturnType<typeof vi.fn>> = []
const onUpdate = vi.fn(() => {
  const unsub = vi.fn()
  unsubscribes.push(unsub)
  return unsub
})
const close = vi.fn(async () => undefined)

vi.mock('convex/browser', () => ({
  ConvexClient: class {
    onUpdate = onUpdate
    mutation = vi.fn(async () => undefined)
    close = close
  },
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  Notification: class {
    show = vi.fn()
  },
}))
vi.mock('./convex-config', () => ({
  CONVEX_CLOUD_URL: 'https://example.convex.cloud',
  CONVEX_SITE_URL: 'https://example.convex.site',
}))
// hasAnyWebhooks() gates startup on at least one action carrying a webhookToken.
vi.mock('./persistence', () => ({
  loadPersistedData: () => ({
    workspaces: {
      ws1: { name: 'ws', customActions: [{ id: 'a1', name: 'act', webhookToken: 'tok' }] },
    },
  }),
}))

const { startWebhookListener, stopWebhookListener } = await import('./webhook-listener')

const RESUBSCRIBE_MS = 30_000

describe('webhook listener subscription liveness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stopWebhookListener()
    onUpdate.mockClear()
    unsubscribes.length = 0
  })

  afterEach(() => {
    stopWebhookListener()
    vi.useRealTimers()
  })

  it('re-opens the subscription on a cadence instead of trusting it forever', () => {
    startWebhookListener()
    expect(onUpdate).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(RESUBSCRIBE_MS * 3)
    expect(onUpdate).toHaveBeenCalledTimes(4)
  })

  it('re-opens well inside the window where a queued event is still worth running', () => {
    // Events older than STALE_EVENT_MS (60s) are expired rather than run, so a
    // wedge has to be detected before then or the recovery is worthless.
    expect(RESUBSCRIBE_MS).toBeLessThan(60_000)
  })

  it('disposes the previous handle each time, so subscriptions never stack', () => {
    startWebhookListener()
    vi.advanceTimersByTime(RESUBSCRIBE_MS * 3)

    // A leaked handle would deliver every event N times over, and processingEvents
    // only dedupes within a tick — so the duplicates race on the claim instead.
    expect(unsubscribes.slice(0, -1).every((u) => u.mock.calls.length === 1)).toBe(true)
    expect(unsubscribes.at(-1)).not.toHaveBeenCalled()
  })

  it('stays stopped after stopWebhookListener', () => {
    startWebhookListener()
    stopWebhookListener()
    const afterStop = onUpdate.mock.calls.length

    // The timer must not outlive the listener and resurrect it.
    vi.advanceTimersByTime(RESUBSCRIBE_MS * 5)
    expect(onUpdate).toHaveBeenCalledTimes(afterStop)
  })

  it('is idempotent — a second start does not open a second subscription', () => {
    startWebhookListener()
    startWebhookListener()
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })
})
