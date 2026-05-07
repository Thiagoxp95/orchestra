import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { CodexNotifyListener, type CodexSessionInfo } from './codex-notify-listener'
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
  let sessionInfos: CodexSessionInfo[]

  beforeEach(() => {
    updates = []
    sessionInfos = []
    listener = new CodexNotifyListener({
      onStatusUpdate: (status) => { updates.push(status) },
      onSessionInfo: (info) => { sessionInfos.push(info) },
    })
  })

  afterEach(() => {
    listener.stop()
  })

  it('emits idle on SessionStart', () => {
    listener.ingest({ sessionId: 'sess', event: 'SessionStart' })
    expect(updates.map((s) => s.state)).toEqual(['idle'])
    expect(updates[0]).toMatchObject({
      sessionId: 'sess',
      agent: 'codex',
      state: 'idle',
      authority: 'codex-hook',
      connected: true,
    })
  })

  it('emits working on UserPromptSubmit (fast-path optimistic flip)', () => {
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    expect(updates.map((s) => s.state)).toEqual(['working'])
  })

  it('drops Stop hook by default — the rollout watcher owns the idle transition', () => {
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    listener.ingest({ sessionId: 'sess', event: 'Stop' })
    // Working surfaced; Stop did NOT propagate as idle. Stop is observed but
    // never authoritative because codex CLI fires it between sub-tasks too.
    expect(updates.map((s) => s.state)).toEqual(['working'])
  })

  it('Stop does not corrupt the cache when dropped — getLatest still reflects working', () => {
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    listener.ingest({ sessionId: 'sess', event: 'Stop' })
    expect(listener.getLatest('sess')?.state).toBe('working')
  })

  it('emits Stop as idle when emitIdleOnStop is explicitly enabled (legacy path)', () => {
    listener.stop()
    listener = new CodexNotifyListener({
      onStatusUpdate: (status) => { updates.push(status) },
      emitIdleOnStop: true,
    })
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    listener.ingest({ sessionId: 'sess', event: 'Stop' })
    expect(updates.map((s) => s.state)).toEqual(['working', 'idle'])
  })

  it('collapses duplicate states on the same session', () => {
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    expect(updates.map((s) => s.state)).toEqual(['working'])
  })

  it('keeps state per session', () => {
    listener.ingest({ sessionId: 'a', event: 'UserPromptSubmit' })
    listener.ingest({ sessionId: 'b', event: 'SessionStart' })
    expect(updates).toHaveLength(2)
    expect(updates[0]).toMatchObject({ sessionId: 'a', state: 'working' })
    expect(updates[1]).toMatchObject({ sessionId: 'b', state: 'idle' })
  })

  it('forgetSession drops cached state so next event always emits', () => {
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    listener.forgetSession('sess')
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    expect(updates.map((s) => s.state)).toEqual(['working', 'working'])
  })

  it('respects isKnownSession — unknown sessions are dropped silently', () => {
    listener.stop()
    const known = new Set<string>(['sess'])
    listener = new CodexNotifyListener({
      onStatusUpdate: (status) => { updates.push(status) },
      isKnownSession: (sid) => known.has(sid),
    })
    listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
    listener.ingest({ sessionId: 'ghost', event: 'UserPromptSubmit' })
    expect(updates.map((s) => s.sessionId)).toEqual(['sess'])
  })

  describe('HTTP transport', () => {
    it('accepts the extended payload shape over POST /codex-hook', async () => {
      const port = await listener.start()
      const res = await postJson(port, '/codex-hook', {
        sessionId: 'sess',
        event: 'SessionStart',
        codexSessionId: 'codex-uuid',
        transcriptPath: '/tmp/rollout.jsonl',
      })
      expect(res.status).toBe(204)
      expect(updates.map((s) => s.state)).toEqual(['idle'])
      expect(sessionInfos).toEqual([
        { sessionId: 'sess', codexSessionId: 'codex-uuid', transcriptPath: '/tmp/rollout.jsonl' },
      ])
    })

    it('returns 400 for malformed bodies', async () => {
      const port = await listener.start()
      const res = await fetch(`http://127.0.0.1:${port}/codex-hook`, {
        method: 'POST',
        body: 'not json',
      })
      expect(res.status).toBe(400)
    })

    it('returns 404 for unknown URLs', async () => {
      const port = await listener.start()
      const res = await postJson(port, '/other', {})
      expect(res.status).toBe(404)
    })
  })

  describe('onSessionInfo (rollout watcher hook)', () => {
    it('fires once when codexSessionId + transcriptPath arrive together', () => {
      listener.ingest({
        sessionId: 'sess',
        event: 'SessionStart',
        codexSessionId: 'codex-uuid',
        transcriptPath: '/tmp/rollout.jsonl',
      })
      expect(sessionInfos).toEqual([
        { sessionId: 'sess', codexSessionId: 'codex-uuid', transcriptPath: '/tmp/rollout.jsonl' },
      ])
    })

    it('does not fire when codexSessionId or transcriptPath is missing', () => {
      listener.ingest({ sessionId: 'sess', event: 'SessionStart', codexSessionId: 'codex-uuid' })
      listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit', transcriptPath: '/tmp/rollout.jsonl' })
      expect(sessionInfos).toEqual([])
    })

    it('deduplicates when the same transcript path arrives on subsequent hooks', () => {
      const info = {
        codexSessionId: 'codex-uuid',
        transcriptPath: '/tmp/rollout.jsonl',
      }
      listener.ingest({ sessionId: 'sess', event: 'SessionStart', ...info })
      listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit', ...info })
      listener.ingest({ sessionId: 'sess', event: 'Stop', ...info })
      expect(sessionInfos).toHaveLength(1)
    })

    it('refires when the transcript path changes (e.g. session resumed onto a new rollout)', () => {
      listener.ingest({
        sessionId: 'sess',
        event: 'SessionStart',
        codexSessionId: 'codex-uuid',
        transcriptPath: '/tmp/a.jsonl',
      })
      listener.ingest({
        sessionId: 'sess',
        event: 'SessionStart',
        codexSessionId: 'codex-uuid',
        transcriptPath: '/tmp/b.jsonl',
      })
      expect(sessionInfos.map((i) => i.transcriptPath)).toEqual(['/tmp/a.jsonl', '/tmp/b.jsonl'])
    })

    it('forgetSession resets dedup so the same transcript path can fire again later', () => {
      const info = { codexSessionId: 'codex-uuid', transcriptPath: '/tmp/rollout.jsonl' }
      listener.ingest({ sessionId: 'sess', event: 'SessionStart', ...info })
      listener.forgetSession('sess')
      listener.ingest({ sessionId: 'sess', event: 'SessionStart', ...info })
      expect(sessionInfos).toHaveLength(2)
    })
  })

  describe('applyExternalState (rollout watcher → listener)', () => {
    it('emits the new state with the supplied authority', () => {
      listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
      listener.applyExternalState('sess', 'idle', 'codex-rollout')
      expect(updates.map((s) => ({ state: s.state, authority: s.authority }))).toEqual([
        { state: 'working', authority: 'codex-hook' },
        { state: 'idle', authority: 'codex-rollout' },
      ])
    })

    it('collapses duplicates against the cache', () => {
      listener.ingest({ sessionId: 'sess', event: 'UserPromptSubmit' })
      listener.applyExternalState('sess', 'working', 'codex-rollout')
      expect(updates).toHaveLength(1)
    })

    it('respects isKnownSession', () => {
      listener.stop()
      listener = new CodexNotifyListener({
        onStatusUpdate: (status) => { updates.push(status) },
        isKnownSession: (sid) => sid === 'sess',
      })
      listener.applyExternalState('ghost', 'idle', 'codex-rollout')
      expect(updates).toEqual([])
    })
  })
})
