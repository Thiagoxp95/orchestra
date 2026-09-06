import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cursorChatsDir } from './agent-resume-ids'
import { SessionResumeTracker, type SessionResumePairing } from './session-resume-tracker'

const CLAUDE_A = '46502127-97dc-451a-81b2-2410f1392a31'
const CLAUDE_B = '11112222-3333-4444-5555-666677778888'
const CURSOR_A = 'aaaaaaaa-1111-2222-3333-444444444444'
const CURSOR_B = 'bbbbbbbb-1111-2222-3333-444444444444'

function seedCursorChat(home: string, cwd: string, chatId: string, mtimeMs: number): void {
  const dir = join(cursorChatsDir(cwd, home), chatId)
  mkdirSync(dir, { recursive: true })
  const store = join(dir, 'store.db')
  writeFileSync(store, 'x')
  utimesSync(store, mtimeMs / 1000, mtimeMs / 1000)
}

function collect() {
  const seen: Array<[string, SessionResumePairing]> = []
  return { seen, onPairing: (id: string, p: SessionResumePairing) => seen.push([id, p]) }
}

describe('SessionResumeTracker (claude/codex)', () => {
  it('reports the conversation the context tracker resolved', () => {
    const { seen, onPairing } = collect()
    const tracker = new SessionResumeTracker({
      resolveTranscript: () => `/p/${CLAUDE_A}.jsonl`,
      onPairing,
    })
    tracker.update([{ sessionId: 's1', agent: 'claude', cwd: '/repo' }])
    expect(seen).toEqual([['s1', { agent: 'claude', resumeSessionId: CLAUDE_A }]])
    expect(tracker.get('s1')).toEqual({ agent: 'claude', resumeSessionId: CLAUDE_A })
  })

  it('reports a pane only once while its conversation is unchanged', () => {
    const { seen, onPairing } = collect()
    const tracker = new SessionResumeTracker({
      resolveTranscript: () => `/p/${CLAUDE_A}.jsonl`,
      onPairing,
    })
    const sessions = [{ sessionId: 's1', agent: 'claude' as const, cwd: '/repo' }]
    tracker.update(sessions)
    tracker.update(sessions)
    tracker.update(sessions)
    expect(seen).toHaveLength(1)
  })

  it('follows a pane onto a new conversation', () => {
    const { seen, onPairing } = collect()
    let file = `/p/${CLAUDE_A}.jsonl`
    const tracker = new SessionResumeTracker({ resolveTranscript: () => file, onPairing })
    const sessions = [{ sessionId: 's1', agent: 'claude' as const, cwd: '/repo' }]
    tracker.update(sessions)
    file = `/p/${CLAUDE_B}.jsonl`
    tracker.update(sessions)
    expect(seen.map(([, p]) => p.resumeSessionId)).toEqual([CLAUDE_A, CLAUDE_B])
  })

  // A pane whose agent exited keeps its pairing — that is the whole point, since
  // the resume offer only appears once the process is gone.
  it('keeps a pairing after the session leaves the tracked set', () => {
    const { onPairing } = collect()
    const tracker = new SessionResumeTracker({
      resolveTranscript: () => `/p/${CLAUDE_A}.jsonl`,
      onPairing,
    })
    tracker.update([{ sessionId: 's1', agent: 'claude', cwd: '/repo' }])
    tracker.update([])
    expect(tracker.get('s1')).toEqual({ agent: 'claude', resumeSessionId: CLAUDE_A })
    tracker.forget('s1')
    expect(tracker.get('s1')).toBeNull()
  })

  it('drops the pairing when the pane swaps agent', () => {
    const { seen, onPairing } = collect()
    let file = `/p/${CLAUDE_A}.jsonl`
    const tracker = new SessionResumeTracker({ resolveTranscript: () => file, onPairing })
    tracker.update([{ sessionId: 's1', agent: 'claude', cwd: '/repo' }])
    file = `/p/rollout-2026-09-06T10-11-12-${CLAUDE_B}.jsonl`
    tracker.update([{ sessionId: 's1', agent: 'codex', cwd: '/repo' }])
    expect(seen.map(([, p]) => p)).toEqual([
      { agent: 'claude', resumeSessionId: CLAUDE_A },
      { agent: 'codex', resumeSessionId: CLAUDE_B },
    ])
  })

  it('reports nothing while no transcript has been resolved', () => {
    const { seen, onPairing } = collect()
    const tracker = new SessionResumeTracker({ resolveTranscript: () => null, onPairing })
    tracker.update([{ sessionId: 's1', agent: 'claude', cwd: '/repo' }])
    expect(seen).toEqual([])
    expect(tracker.get('s1')).toBeNull()
  })
})

describe('SessionResumeTracker (cursor)', () => {
  const cwd = '/Users/x/repo'

  it('pairs a freshly opened pane with a chat written after it opened', () => {
    const home = mkdtempSync(join(tmpdir(), 'resume-tracker-'))
    const { seen, onPairing } = collect()
    // startedAt well in the past: this pane is a NEW one, not one adopted at launch.
    const tracker = new SessionResumeTracker({
      resolveTranscript: () => null,
      onPairing,
      home,
      startedAt: 1_000_000,
      now: () => 2_000_000,
    })
    seedCursorChat(home, cwd, CURSOR_A, 2_000_500)
    tracker.update([{ sessionId: 's1', agent: 'cursor', cwd }])
    expect(seen).toEqual([['s1', { agent: 'cursor', resumeSessionId: CURSOR_A }]])
  })

  // The foreign-pairing bug: a pane opened NOW must not adopt the conversation
  // that was already sitting in this folder from yesterday.
  it('refuses a chat older than the pane that would claim it', () => {
    const home = mkdtempSync(join(tmpdir(), 'resume-tracker-'))
    const { seen, onPairing } = collect()
    const tracker = new SessionResumeTracker({
      resolveTranscript: () => null,
      onPairing,
      home,
      startedAt: 1_000_000,
      now: () => 2_000_000,
    })
    seedCursorChat(home, cwd, CURSOR_A, 1_500_000)
    tracker.update([{ sessionId: 's1', agent: 'cursor', cwd }])
    expect(seen).toEqual([])
  })

  // …but a pane this process ADOPTED at launch has only older evidence by
  // definition, so the floor must not apply to it.
  it('pairs an adopted pane with a chat that predates the launch', () => {
    const home = mkdtempSync(join(tmpdir(), 'resume-tracker-'))
    const { seen, onPairing } = collect()
    const tracker = new SessionResumeTracker({
      resolveTranscript: () => null,
      onPairing,
      home,
      startedAt: 2_000_000,
      now: () => 2_000_100,
    })
    seedCursorChat(home, cwd, CURSOR_A, 1_500_000)
    tracker.update([{ sessionId: 's1', agent: 'cursor', cwd }])
    expect(seen).toEqual([['s1', { agent: 'cursor', resumeSessionId: CURSOR_A }]])
  })

  it('does not let a second pane steal the first pane\'s chat', () => {
    const home = mkdtempSync(join(tmpdir(), 'resume-tracker-'))
    const { seen, onPairing } = collect()
    const tracker = new SessionResumeTracker({
      resolveTranscript: () => null,
      onPairing,
      home,
      startedAt: 2_000_000,
      now: () => 2_000_100,
    })
    seedCursorChat(home, cwd, CURSOR_A, 1_400_000)
    seedCursorChat(home, cwd, CURSOR_B, 1_500_000)
    tracker.update([
      { sessionId: 's1', agent: 'cursor', cwd },
      { sessionId: 's2', agent: 'cursor', cwd },
    ])
    expect(tracker.get('s1')?.resumeSessionId).toBe(CURSOR_B)
    expect(tracker.get('s2')?.resumeSessionId).toBe(CURSOR_A)
    expect(seen).toHaveLength(2)
  })

  // Once pinned, a newer chat opened elsewhere must not walk off with the pairing.
  it('keeps a pinned chat when a newer one appears', () => {
    const home = mkdtempSync(join(tmpdir(), 'resume-tracker-'))
    const { onPairing } = collect()
    const tracker = new SessionResumeTracker({
      resolveTranscript: () => null,
      onPairing,
      home,
      startedAt: 2_000_000,
      now: () => 2_000_100,
    })
    seedCursorChat(home, cwd, CURSOR_A, 1_400_000)
    tracker.update([{ sessionId: 's1', agent: 'cursor', cwd }])
    seedCursorChat(home, cwd, CURSOR_B, 2_900_000)
    tracker.update([{ sessionId: 's1', agent: 'cursor', cwd }])
    expect(tracker.get('s1')?.resumeSessionId).toBe(CURSOR_A)
  })
})
