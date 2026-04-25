import { describe, expect, it, beforeEach, afterEach } from 'vitest'
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
