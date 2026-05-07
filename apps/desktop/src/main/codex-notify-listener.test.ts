import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { CodexNotifyListener } from './codex-notify-listener'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'

async function postJson(port: number, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('CodexNotifyListener', () => {
  let listener: CodexNotifyListener
  let updates: NormalizedAgentSessionStatus[]
  let port: number

  beforeEach(async () => {
    updates = []
    listener = new CodexNotifyListener({
      onStatusUpdate: (status) => { updates.push(status) },
    })
    port = await listener.start()
  })

  afterEach(() => {
    listener.stop()
  })

  it('binds to a free localhost port', () => {
    expect(port).toBeGreaterThan(0)
  })

  it('maps UserPromptSubmit to working', async () => {
    const res = await postJson(port, '/codex-hook', { sessionId: 'sess-1', event: 'UserPromptSubmit' })
    expect(res.status).toBe(204)
    expect(updates).toHaveLength(1)
    expect(updates[0].sessionId).toBe('sess-1')
    expect(updates[0].state).toBe('working')
    expect(updates[0].agent).toBe('codex')
    expect(updates[0].authority).toBe('codex-hook')
    expect(updates[0].connected).toBe(true)
  })

  it('maps Stop to idle', async () => {
    await postJson(port, '/codex-hook', { sessionId: 'sess-2', event: 'UserPromptSubmit' })
    await postJson(port, '/codex-hook', { sessionId: 'sess-2', event: 'Stop' })
    expect(updates.at(-1)?.state).toBe('idle')
  })

  it('coalesces duplicate same-state events', async () => {
    await postJson(port, '/codex-hook', { sessionId: 'sess-3', event: 'UserPromptSubmit' })
    await postJson(port, '/codex-hook', { sessionId: 'sess-3', event: 'UserPromptSubmit' })
    expect(updates).toHaveLength(1)
  })

  it('rejects malformed JSON with 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/codex-hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
    expect(updates).toHaveLength(0)
  })

  it('rejects unknown event names with 400', async () => {
    const res = await postJson(port, '/codex-hook', { sessionId: 'sess-4', event: 'BogusEvent' })
    expect(res.status).toBe(400)
    expect(updates).toHaveLength(0)
  })

  it('returns 404 for non-matching paths', async () => {
    const res = await postJson(port, '/wrong-path', { sessionId: 'x', event: 'Stop' })
    expect(res.status).toBe(404)
  })

  it('drops events for sessions that the host considers unknown', async () => {
    listener.stop()
    listener = new CodexNotifyListener({
      onStatusUpdate: (status) => { updates.push(status) },
      isKnownSession: (id) => id === 'allowed',
    })
    port = await listener.start()
    const blocked = await postJson(port, '/codex-hook', { sessionId: 'other', event: 'UserPromptSubmit' })
    const allowed = await postJson(port, '/codex-hook', { sessionId: 'allowed', event: 'UserPromptSubmit' })
    expect(blocked.status).toBe(204)
    expect(allowed.status).toBe(204)
    expect(updates).toHaveLength(1)
    expect(updates[0].sessionId).toBe('allowed')
  })

  it('ignest() exposes the same logic as the HTTP path for tests', () => {
    const result = listener.ingest({ sessionId: 'sess-direct', event: 'Stop' })
    expect(result?.state).toBe('idle')
    expect(updates.at(-1)?.sessionId).toBe('sess-direct')
  })

  it('markRunStarted() marks a renderer-started Codex run as working before hooks arrive', () => {
    const result = listener.markRunStarted('sess-launch')
    expect(result?.state).toBe('working')
    expect(result?.sessionId).toBe('sess-launch')
    expect(updates).toHaveLength(1)
    expect(updates[0].state).toBe('working')
  })

  it('markRunStarted() can recover working state after a premature Stop hook', () => {
    listener.ingest({ sessionId: 'sess-background-job', event: 'UserPromptSubmit' })
    listener.ingest({ sessionId: 'sess-background-job', event: 'Stop' })

    const recovered = listener.markRunStarted('sess-background-job')

    expect(recovered?.state).toBe('working')
    expect(listener.getLatest('sess-background-job')?.state).toBe('working')
    expect(updates.map((status) => status.state)).toEqual(['working', 'idle', 'working'])
  })

  it('getLatest() returns the most recent cached status, or null if unknown', () => {
    expect(listener.getLatest('never-seen')).toBeNull()
    listener.ingest({ sessionId: 'sess-cache', event: 'UserPromptSubmit' })
    const working = listener.getLatest('sess-cache')
    expect(working?.state).toBe('working')
    listener.ingest({ sessionId: 'sess-cache', event: 'Stop' })
    expect(listener.getLatest('sess-cache')?.state).toBe('idle')
  })

  it('getLatest() forgets state after forgetSession()', () => {
    listener.ingest({ sessionId: 'sess-forget', event: 'UserPromptSubmit' })
    expect(listener.getLatest('sess-forget')?.state).toBe('working')
    listener.forgetSession('sess-forget')
    expect(listener.getLatest('sess-forget')).toBeNull()
  })

  it('stop() closes the server', async () => {
    listener.stop()
    let failed = false
    try {
      await postJson(port, '/codex-hook', { sessionId: 'x', event: 'Stop' })
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })
})

describe('CodexNotifyListener — banner-gated stop deferral', () => {
  let listener: CodexNotifyListener
  let updates: NormalizedAgentSessionStatus[]
  const stopDeferralMs = 100

  beforeEach(() => {
    updates = []
    listener = new CodexNotifyListener({
      onStatusUpdate: (status) => { updates.push(status) },
      stopDeferralMs,
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    listener.stop()
    vi.useRealTimers()
  })

  it('processes Stop immediately when no banner has ever been seen', () => {
    // The banner gate only kicks in once we've actually observed the
    // working banner — without that signal we can't tell a real idle
    // from a sub-task flicker, so default to processing the Stop.
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    listener.ingest({ sessionId: 'sess', event: 'Stop' })

    expect(updates.map((s) => s.state)).toEqual(['working', 'idle'])
  })

  it('cancels the deferred Stop when codex resumes with UserPromptSubmit', () => {
    // User-reported regression: codex CLI fires a Stop hook between
    // sub-tasks of a turn (e.g. agent-turn-complete from one model call
    // before the next sub-task's UserPromptSubmit) while the working
    // banner keeps ticking. Without the gate, the brief idle leaks out
    // as a spurious "needs input" notification mid-turn and the
    // sessionNeedsUserInput flag stays stuck on. The gate defers Stop
    // while the banner is still fresh, and a subsequent
    // UserPromptSubmit cancels the pending Stop entirely so no idle
    // ever reaches the renderer.
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    listener.noteBannerSeen('sess')
    expect(updates.map((s) => s.state)).toEqual(['working'])

    listener.ingest({ sessionId: 'sess', event: 'Stop' })
    // The cache reflects the latest intent eagerly so PTY-recovery
    // doesn't re-issue a Stop while one is pending.
    expect(listener.getLatest('sess')?.state).toBe('idle')
    // But onStatusUpdate hasn't fired with idle yet.
    expect(updates.map((s) => s.state)).toEqual(['working'])

    // Codex fires UserPromptSubmit for the next sub-task before the
    // banner ever goes stale.
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    expect(updates.map((s) => s.state)).toEqual(['working', 'working'])
    expect(listener.getLatest('sess')?.state).toBe('working')

    // Advance well past the deferral window to confirm no late idle leaks.
    vi.advanceTimersByTime(stopDeferralMs * 5)
    expect(updates.map((s) => s.state)).toEqual(['working', 'working'])
  })

  it('keeps the Stop pinned indefinitely while banner ticks keep arriving', () => {
    // Every banner tick pushes the deferred emit back, so a long
    // multi-minute turn with steady banner ticks (every ~100ms) never
    // emits the spurious idle even if codex CLI fires a stray Stop near
    // the start.
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    listener.noteBannerSeen('sess')
    listener.ingest({ sessionId: 'sess', event: 'Stop' })

    // Simulate banner ticks every 50ms for 10× the deferral window.
    for (let i = 0; i < stopDeferralMs / 5; i++) {
      vi.advanceTimersByTime(50)
      listener.noteBannerSeen('sess')
    }

    // No idle has been emitted — banner kept the Stop deferred.
    expect(updates.map((s) => s.state)).toEqual(['working'])

    // Now banner stops ticking and the deferral window elapses.
    vi.advanceTimersByTime(stopDeferralMs + 10)
    expect(updates.map((s) => s.state)).toEqual(['working', 'idle'])
  })

  it('emits idle once the banner has actually been silent for the deferral window', () => {
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    listener.noteBannerSeen('sess')
    listener.ingest({ sessionId: 'sess', event: 'Stop' })
    expect(updates.map((s) => s.state)).toEqual(['working'])

    // Deferral window elapses without any banner ticks — codex really
    // did finish.
    vi.advanceTimersByTime(stopDeferralMs + 10)
    expect(updates.map((s) => s.state)).toEqual(['working', 'idle'])
  })

  it('processes Stop immediately when the banner has already gone stale', () => {
    // Banner was seen but not in the recent past — treat the Stop as a
    // real one without further deferral.
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    listener.noteBannerSeen('sess')
    vi.advanceTimersByTime(stopDeferralMs * 5)

    listener.ingest({ sessionId: 'sess', event: 'Stop' })
    expect(updates.map((s) => s.state)).toEqual(['working', 'idle'])
  })

  it('does not defer SessionStart-driven idle (no working state preceded it)', () => {
    listener.noteBannerSeen('sess')
    listener.ingest({ sessionId: 'sess', event: 'SessionStart' })
    expect(updates.map((s) => s.state)).toEqual(['idle'])
  })

  it('forgetSession cancels any pending Stop and clears banner timestamp', () => {
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    listener.noteBannerSeen('sess')
    listener.ingest({ sessionId: 'sess', event: 'Stop' })

    listener.forgetSession('sess')
    vi.advanceTimersByTime(stopDeferralMs * 2)

    // The pending Stop was cancelled by forgetSession and never emitted.
    expect(updates.map((s) => s.state)).toEqual(['working'])
    // The banner timestamp was cleared, so a fresh Stop on a new
    // session of the same id processes immediately (no stale banner gate).
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    listener.ingest({ sessionId: 'sess', event: 'Stop' })
    expect(updates.map((s) => s.state)).toEqual(['working', 'working', 'idle'])
  })
})
