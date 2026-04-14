import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  isTurnTrulyEnded,
  isTurnTrulyEndedStrict,
  readLastTranscriptEntry,
  readRecentTranscriptEntries,
  createHeartbeatDetector,
  type HeartbeatDetectorDeps,
  type TranscriptEntry,
} from './claude-heartbeat-detector'

describe('isTurnTrulyEnded (v1 single-entry gate, kept for back-compat)', () => {
  it('returns false for a null entry', () => {
    expect(isTurnTrulyEnded(null)).toBe(false)
  })

  it('returns false when last entry is a user message', () => {
    expect(
      isTurnTrulyEnded({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }),
    ).toBe(false)
  })

  it('returns false when assistant message contains a tool_use block', () => {
    expect(
      isTurnTrulyEnded({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'calling bash' },
            { type: 'tool_use' } as any,
          ],
        },
      }),
    ).toBe(false)
  })

  it('returns true when assistant message has only text blocks', () => {
    expect(
      isTurnTrulyEnded({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      }),
    ).toBe(true)
  })

  it('returns false when assistant content is empty or missing', () => {
    expect(isTurnTrulyEnded({ type: 'assistant', message: { content: [] } })).toBe(false)
    expect(isTurnTrulyEnded({ type: 'assistant', message: {} })).toBe(false)
    expect(isTurnTrulyEnded({ type: 'assistant' })).toBe(false)
  })
})

describe('isTurnTrulyEndedStrict (v2 windowed gate)', () => {
  it('returns false for empty window', () => {
    expect(isTurnTrulyEndedStrict([])).toBe(false)
  })

  it('returns true for a clean text-only finish', () => {
    expect(
      isTurnTrulyEndedStrict([
        { type: 'user', message: { content: [{ type: 'text', text: 'q' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },
      ]),
    ).toBe(true)
  })

  it('returns false when a tool_use is still awaiting its tool_result', () => {
    expect(
      isTurnTrulyEndedStrict([
        { type: 'user', message: { content: [{ type: 'text', text: 'q' }] } },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'call_1' } as any,
              { type: 'text', text: 'thinking further' },
            ],
          },
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'final text' }] } },
      ]),
    ).toBe(false)
  })

  it('returns true when every tool_use has a matching tool_result and final is text', () => {
    expect(
      isTurnTrulyEndedStrict([
        { type: 'user', message: { content: [{ type: 'text', text: 'q' }] } },
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'call_1' } as any] },
        },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'call_1' } as any] },
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      ]),
    ).toBe(true)
  })

  it('returns false when last entry is a user/tool_result', () => {
    expect(
      isTurnTrulyEndedStrict([
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c' } as any] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c' } as any] } },
      ]),
    ).toBe(false)
  })
})

describe('readLastTranscriptEntry / readRecentTranscriptEntries', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-transcript-'))
  })

  function writeTranscript(lines: object[]): string {
    const file = path.join(tmpDir, 'session.jsonl')
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return file
  }

  it('returns null when the file is missing', () => {
    expect(readLastTranscriptEntry(path.join(tmpDir, 'nope.jsonl'))).toBeNull()
    expect(readRecentTranscriptEntries(path.join(tmpDir, 'nope.jsonl'))).toEqual([])
  })

  it('returns null/empty when the path is empty', () => {
    expect(readLastTranscriptEntry('')).toBeNull()
    expect(readRecentTranscriptEntries('')).toEqual([])
  })

  it('returns null/empty for an empty file', () => {
    const file = path.join(tmpDir, 'empty.jsonl')
    fs.writeFileSync(file, '')
    expect(readLastTranscriptEntry(file)).toBeNull()
    expect(readRecentTranscriptEntries(file)).toEqual([])
  })

  it('returns the last parseable entry even when trailing lines are malformed', () => {
    const file = writeTranscript([
      { type: 'user', message: { content: [{ type: 'text', text: 'prompt' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },
    ])
    fs.appendFileSync(file, '{ malformed json ...\n')
    const entry = readLastTranscriptEntry(file)
    expect(entry?.type).toBe('assistant')
  })

  it('readRecentTranscriptEntries returns oldest-first', () => {
    const file = writeTranscript([
      { type: 'user', message: { content: [{ type: 'text', text: 'q' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } },
    ])
    const entries = readRecentTranscriptEntries(file)
    expect(entries.map((e) => e.type)).toEqual(['user', 'assistant'])
  })
})

describe('createHeartbeatDetector', () => {
  interface FakeTimer {
    id: number
    ms: number
    fn: () => void
    fired: boolean
    cancelled: boolean
  }

  function makeFakeClock() {
    const timers: FakeTimer[] = []
    let nextId = 1
    return {
      setTimer: (fn: () => void, ms: number) => {
        const t: FakeTimer = { id: nextId++, ms, fn, fired: false, cancelled: false }
        timers.push(t)
        return t
      },
      clearTimer: (handle: unknown) => {
        const t = handle as FakeTimer
        t.cancelled = true
      },
      runNext(): void {
        for (let i = timers.length - 1; i >= 0; i--) {
          const t = timers[i]
          if (!t.cancelled && !t.fired) {
            t.fired = true
            t.fn()
            return
          }
        }
        throw new Error('no pending timer')
      },
      pendingCount(): number {
        return timers.filter((t) => !t.cancelled && !t.fired).length
      },
      totalScheduled(): number {
        return timers.length
      },
    }
  }

  interface StopCall {
    sessionId: string
    expectedTurnId: string
  }

  function makeDeps(overrides: Partial<HeartbeatDetectorDeps> = {}) {
    const stops: StopCall[] = []
    const clock = makeFakeClock()
    const deps: HeartbeatDetectorDeps = {
      quietMs: 15000,
      getTranscriptPath: () => '/tmp/fake.jsonl',
      isStillWorking: () => true,
      getCurrentTurnId: () => 'turn-1',
      synthesizeStop: (sessionId: string, expectedTurnId: string) =>
        stops.push({ sessionId, expectedTurnId }),
      readRecentEntries: () => [],
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      ...overrides,
    }
    return { deps, clock, stops }
  }

  const finishedAssistantEntry: TranscriptEntry = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'done' }] },
  }

  it('does NOT synthesize Stop when transcript shows a pending tool_use', () => {
    const { deps, clock, stops } = makeDeps({
      readRecentEntries: () => [
        { type: 'user', message: { content: [{ type: 'text', text: 'q' }] } },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'call_1' } as any,
              { type: 'text', text: 'calling' },
            ],
          },
        },
      ],
    })
    const h = createHeartbeatDetector(deps)
    h.schedule('sess-1')
    clock.runNext()
    expect(stops).toEqual([])
  })

  it('reschedules when turn is still active', () => {
    const { deps, clock, stops } = makeDeps({
      readRecentEntries: () => [
        { type: 'user', message: { content: [{ type: 'text', text: 'tool_result' }] } },
      ],
    })
    const h = createHeartbeatDetector(deps)
    h.schedule('sess-1')
    clock.runNext()
    expect(stops).toEqual([])
    expect(clock.pendingCount()).toBe(1)
  })

  it('synthesizes Stop bound to the turnId observed at schedule time', () => {
    const { deps, clock, stops } = makeDeps({
      readRecentEntries: () => [
        { type: 'user', message: { content: [{ type: 'text', text: 'q' }] } },
        finishedAssistantEntry,
      ],
    })
    const h = createHeartbeatDetector(deps)
    h.schedule('sess-1')
    clock.runNext()
    expect(stops).toEqual([{ sessionId: 'sess-1', expectedTurnId: 'turn-1' }])
  })

  it('drops the fire when the turn rotated between schedule and fire', () => {
    let currentTurn = 'turn-A'
    const { deps, clock, stops } = makeDeps({
      getCurrentTurnId: () => currentTurn,
      readRecentEntries: () => [
        { type: 'user', message: { content: [{ type: 'text', text: 'q' }] } },
        finishedAssistantEntry,
      ],
    })
    const h = createHeartbeatDetector(deps)
    h.schedule('sess-1')
    currentTurn = 'turn-B' // user interrupted + retyped
    clock.runNext()
    expect(stops).toEqual([])
    // Also should NOT reschedule — the new turn will schedule its own beat.
    expect(clock.pendingCount()).toBe(0)
  })

  it('does nothing when session is no longer working at fire time', () => {
    const { deps, clock, stops } = makeDeps({
      isStillWorking: () => false,
      readRecentEntries: () => [finishedAssistantEntry],
    })
    const h = createHeartbeatDetector(deps)
    h.schedule('sess-1')
    clock.runNext()
    expect(stops).toEqual([])
  })

  it('clear() cancels the pending timer', () => {
    const { deps, clock, stops } = makeDeps({
      readRecentEntries: () => [finishedAssistantEntry],
    })
    const h = createHeartbeatDetector(deps)
    h.schedule('sess-1')
    h.clear('sess-1')
    expect(clock.pendingCount()).toBe(0)
    expect(stops).toEqual([])
  })

  it('schedule() replaces an existing timer rather than stacking', () => {
    const { deps, clock } = makeDeps()
    const h = createHeartbeatDetector(deps)
    h.schedule('sess-1')
    h.schedule('sess-1')
    h.schedule('sess-1')
    expect(clock.pendingCount()).toBe(1)
    expect(clock.totalScheduled()).toBe(3)
  })

  it('does NOT synthesize Stop when transcript is empty', () => {
    const { deps, clock, stops } = makeDeps({
      readRecentEntries: () => [],
    })
    const h = createHeartbeatDetector(deps)
    h.schedule('sess-1')
    clock.runNext()
    expect(stops).toEqual([])
    expect(clock.pendingCount()).toBe(1) // rescheduled
  })
})
