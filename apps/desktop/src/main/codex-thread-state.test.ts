import { describe, expect, it } from 'vitest'
import {
  CODEX_THREAD_ASSIGNMENT_GRACE_MS,
  extractLastCodexResponse,
  getConservativeCodexWorkState,
  getCodexWorkState,
  getCodexWorkStateFromThread,
  pickAssignableCodexThreadId,
  rankCodexThreads,
  wasCodexThreadUpdatedForProcess,
} from './codex-thread-state'

describe('getCodexWorkState', () => {
  it('treats active threads without blocking flags as working', () => {
    expect(getCodexWorkState({ type: 'active', activeFlags: [] })).toBe('working')
  })

  it('surfaces waiting states explicitly', () => {
    expect(getCodexWorkState({ type: 'active', activeFlags: ['waitingOnUserInput'] })).toBe('waitingUserInput')
    expect(getCodexWorkState({ type: 'active', activeFlags: ['waitingOnApproval'] })).toBe('waitingApproval')
  })

  it('treats non-active states as idle', () => {
    expect(getCodexWorkState({ type: 'idle' })).toBe('idle')
    expect(getCodexWorkState({ type: 'notLoaded' })).toBe('idle')
    expect(getCodexWorkState({ type: 'systemError' })).toBe('idle')
    expect(getCodexWorkState(undefined)).toBe('idle')
  })
})

describe('getConservativeCodexWorkState', () => {
  it('settles non-active summaries to idle', () => {
    expect(getConservativeCodexWorkState({ type: 'idle' })).toBe('idle')
    expect(getConservativeCodexWorkState(undefined)).toBe('idle')
  })

  it('settles blocked active summaries to explicit waiting states', () => {
    expect(getConservativeCodexWorkState({
      type: 'active',
      activeFlags: ['waitingOnApproval'],
    })).toBe('waitingApproval')
  })

  it('treats plain active summaries as ambiguous instead of working', () => {
    expect(getConservativeCodexWorkState({
      type: 'active',
      activeFlags: [],
    })).toBeNull()
  })
})

describe('extractLastCodexResponse', () => {
  it('prefers the latest final answer over commentary', () => {
    expect(extractLastCodexResponse({
      turns: [
        {
          status: 'completed',
          items: [
            { type: 'agentMessage', text: 'Working through it', phase: 'commentary' },
            { type: 'agentMessage', text: 'Final response', phase: 'final_answer' },
          ],
        },
      ],
    })).toBe('Final response')
  })

  it('returns the latest agent message text across turns', () => {
    expect(extractLastCodexResponse({
      turns: [
        {
          items: [
            { type: 'userMessage', text: 'ignored' },
            { type: 'agentMessage', text: 'First response' },
          ],
        },
        {
          items: [
            { type: 'agentMessage', text: 'Second response' },
          ],
        },
      ],
    })).toBe('Second response')
  })

  it('ignores empty agent messages', () => {
    expect(extractLastCodexResponse({
      turns: [
        {
          items: [
            { type: 'agentMessage', text: '   ' },
            { type: 'agentMessage', text: 'Real response' },
          ],
        },
      ],
    })).toBe('Real response')
  })
})

describe('getCodexWorkStateFromThread', () => {
  it('treats an in-progress turn as working', () => {
    expect(getCodexWorkStateFromThread({
      status: { type: 'active', activeFlags: [] },
      turns: [{ status: 'inProgress', items: [] }],
    })).toBe('working')
  })

  it('still treats an in-progress turn as working when thread status is notLoaded', () => {
    expect(getCodexWorkStateFromThread({
      status: { type: 'notLoaded' },
      turns: [{ status: 'inProgress', items: [] }],
    })).toBe('working')
  })

  it('treats completed turns as idle even when thread status is still active', () => {
    expect(getCodexWorkStateFromThread({
      status: { type: 'active', activeFlags: [] },
      turns: [{ status: 'completed', items: [] }],
    })).toBe('idle')
  })

  it('respects blocking active flags for in-progress turns', () => {
    expect(getCodexWorkStateFromThread({
      status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
      turns: [{ status: 'inProgress', items: [] }],
    })).toBe('waitingUserInput')
  })

  it('surfaces approval waits from in-progress turns', () => {
    expect(getCodexWorkStateFromThread({
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      turns: [{ status: 'inProgress', items: [] }],
    })).toBe('waitingApproval')
  })
})

describe('pickAssignableCodexThreadId', () => {
  const threads = [
    { id: 'older', createdAt: 100, updatedAt: 200, status: { type: 'idle' as const } },
    { id: 'loaded', createdAt: 10, updatedAt: 300, status: { type: 'active' as const, activeFlags: [] } },
    { id: 'newer', createdAt: 102, updatedAt: 250, status: { type: 'idle' as const } },
  ]

  it('prefers loaded threads before time proximity', () => {
    expect(rankCodexThreads(threads, 102_000, new Set(['loaded']))[0]?.id).toBe('loaded')
  })

  it('skips threads claimed by another session', () => {
    expect(pickAssignableCodexThreadId(
      threads,
      102_000,
      new Set(['loaded']),
      new Map([['loaded', 'other-session']]),
      'session-a',
    )).toBe('newer')
  })

  it('allows reusing the thread already owned by the same session', () => {
    expect(pickAssignableCodexThreadId(
      threads,
      102_000,
      new Set(['loaded']),
      new Map([['loaded', 'session-a']]),
      'session-a',
    )).toBe('loaded')
  })
})

describe('wasCodexThreadUpdatedForProcess', () => {
  it('accepts threads updated after the process started', () => {
    expect(wasCodexThreadUpdatedForProcess({
      id: 'thread-a',
      createdAt: 100,
      updatedAt: 140,
      status: { type: 'idle' },
    }, 130_000)).toBe(true)
  })

  it('accepts threads updated shortly before the process start within grace', () => {
    expect(wasCodexThreadUpdatedForProcess({
      id: 'thread-a',
      createdAt: 100,
      updatedAt: 100,
      status: { type: 'idle' },
    }, 100_000 + CODEX_THREAD_ASSIGNMENT_GRACE_MS - 5_000)).toBe(true)
  })

  it('rejects stale threads last updated well before the current process existed', () => {
    expect(wasCodexThreadUpdatedForProcess({
      id: 'thread-a',
      createdAt: 100,
      updatedAt: 100,
      status: { type: 'idle' },
    }, 100_000 + CODEX_THREAD_ASSIGNMENT_GRACE_MS + 5_000)).toBe(false)
  })
})
