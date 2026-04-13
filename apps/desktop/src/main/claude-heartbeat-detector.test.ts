import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  isTurnTrulyEnded,
  readLastTranscriptEntry,
  createHeartbeatDetector,
  type HeartbeatDetectorDeps,
  type TranscriptEntry,
} from './claude-heartbeat-detector'

describe('isTurnTrulyEnded', () => {
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

describe('readLastTranscriptEntry', () => {
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
  })

  it('returns null when the path is empty', () => {
    expect(readLastTranscriptEntry('')).toBeNull()
  })

  it('returns null for an empty file', () => {
    const file = path.join(tmpDir, 'empty.jsonl')
    fs.writeFileSync(file, '')
    expect(readLastTranscriptEntry(file)).toBeNull()
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
      /** Fire the most recently scheduled non-cancelled timer. */
      runNext(): void {
        // Walk backward — the most recent schedule() call is the active one.
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

  function makeDeps(overrides: Partial<HeartbeatDetectorDeps> = {}) {
    const stops: string[] = []
    const clock = makeFakeClock()
    const deps: HeartbeatDetectorDeps = {
      quietMs: 4000,
      getTranscriptPath: () => '/tmp/fake.jsonl',
      isStillWorking: () => true,
      synthesizeStop: (id: string) => stops.push(id),
      readLastEntry: () => null,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      ...overrides,
    }
    return { deps, clock, stops }
  }

  it('does NOT synthesize Stop when transcript shows a pending tool_use', () => {
    const { deps, clock, stops } = makeDeps({
      readLastEntry: (): TranscriptEntry => ({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'calling' }, { type: 'tool_use' } as any] },
      }),
    })
    const h = createHeartbeatDetector(deps)

    h.schedule('sess-1')
    clock.runNext()

    expect(stops).toEqual([])
  })

  it('reschedules another heartbeat when turn is still active', () => {
    const { deps, clock, stops } = makeDeps({
      readLastEntry: (): TranscriptEntry => ({
        type: 'user',
        message: { content: [{ type: 'text', text: 'tool_result' }] },
      }),
    })
    const h = createHeartbeatDetector(deps)

    h.schedule('sess-1')
    clock.runNext()

    expect(stops).toEqual([])
    expect(clock.pendingCount()).toBe(1)
  })

  it('synthesizes Stop when transcript shows assistant-text-only entry', () => {
    const { deps, clock, stops } = makeDeps({
      readLastEntry: (): TranscriptEntry => ({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'all done' }] },
      }),
    })
    const h = createHeartbeatDetector(deps)

    h.schedule('sess-1')
    clock.runNext()

    expect(stops).toEqual(['sess-1'])
  })

  it('does nothing when session is no longer working at fire time', () => {
    const { deps, clock, stops } = makeDeps({
      isStillWorking: () => false,
      readLastEntry: (): TranscriptEntry => ({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'all done' }] },
      }),
    })
    const h = createHeartbeatDetector(deps)

    h.schedule('sess-1')
    clock.runNext()

    expect(stops).toEqual([])
  })

  it('clear() cancels the pending timer before it fires', () => {
    const { deps, clock, stops } = makeDeps({
      readLastEntry: (): TranscriptEntry => ({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      }),
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
    expect(clock.totalScheduled()).toBe(3) // 3 timers created, 2 cancelled
  })

  it('does NOT synthesize Stop when transcript is missing (no assistant message yet)', () => {
    const { deps, clock, stops } = makeDeps({
      readLastEntry: () => null,
    })
    const h = createHeartbeatDetector(deps)

    h.schedule('sess-1')
    clock.runNext()

    expect(stops).toEqual([])
    expect(clock.pendingCount()).toBe(1) // rescheduled
  })
})
