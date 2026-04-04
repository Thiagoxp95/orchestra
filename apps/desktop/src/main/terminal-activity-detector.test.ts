import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startTracking,
  stopTracking,
  initActivityDetector,
  stopActivityDetector,
  _getState,
  _tickAll,
} from './terminal-activity-detector'
import type { ActivityState } from '../shared/types'

describe('terminal-activity-detector', () => {
  let snapshotProvider: (sessionId: string) => string
  let titleAnimatingProvider: (sessionId: string) => boolean
  let emittedStates: { sessionId: string; state: ActivityState }[]

  beforeEach(() => {
    snapshotProvider = vi.fn(() => '')
    titleAnimatingProvider = vi.fn(() => false)
    emittedStates = []
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: titleAnimatingProvider,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
  })

  afterEach(() => {
    stopActivityDetector()
  })

  it('starts in idle state', () => {
    startTracking('s1')
    expect(_getState('s1')).toBe('idle')
  })

  it('transitions to working when content changes', () => {
    let content = 'hello'
    snapshotProvider = vi.fn(() => content)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: () => false,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
    startTracking('s1')

    _tickAll()
    content = 'hello world'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'working' }])
  })

  it('transitions to idle after content stops changing for idle timeout', () => {
    vi.useFakeTimers()
    let content = 'a'
    snapshotProvider = vi.fn(() => content)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: () => false,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
      idleTimeoutMs: 100,
    })
    startTracking('s1')

    _tickAll()
    content = 'b'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'working' }])

    vi.advanceTimersByTime(150)
    _tickAll()
    expect(emittedStates).toEqual([
      { sessionId: 's1', state: 'working' },
      { sessionId: 's1', state: 'idle' },
    ])
    vi.useRealTimers()
  })

  it('detects thinking sub-state when title is animating', () => {
    let content = 'output\n✻ Thinking\n'
    snapshotProvider = vi.fn(() => content)
    titleAnimatingProvider = vi.fn(() => true)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: titleAnimatingProvider,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
    startTracking('s1')

    _tickAll()
    content = 'output\n✻ Thinking harder\n'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'thinking' }])
  })

  it('detects tool_executing sub-state', () => {
    let content = 'output\n✻ Read src/main.ts\n'
    snapshotProvider = vi.fn(() => content)
    titleAnimatingProvider = vi.fn(() => true)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: titleAnimatingProvider,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
    startTracking('s1')

    _tickAll()
    content = 'output\n✻ Read src/main.ts more\n'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'tool_executing' }])
  })

  it('falls back to working when title animating but no pattern match', () => {
    let content = 'some random output'
    snapshotProvider = vi.fn(() => content)
    titleAnimatingProvider = vi.fn(() => true)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: titleAnimatingProvider,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
    startTracking('s1')

    _tickAll()
    content = 'some random output changed'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'working' }])
  })

  it('detects stalled when title animating but content frozen', () => {
    vi.useFakeTimers()
    let content = 'frozen content'
    snapshotProvider = vi.fn(() => content)
    titleAnimatingProvider = vi.fn(() => true)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: titleAnimatingProvider,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
      stalledTimeoutMs: 200,
    })
    startTracking('s1')

    _tickAll() // initialize
    content = 'frozen content changed'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'working' }])

    // Content freezes but title still animating
    vi.advanceTimersByTime(250)
    _tickAll()
    expect(emittedStates).toEqual([
      { sessionId: 's1', state: 'working' },
      { sessionId: 's1', state: 'stalled' },
    ])
    vi.useRealTimers()
  })

  it('does not emit duplicate states', () => {
    let content = 'a'
    snapshotProvider = vi.fn(() => content)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: () => false,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
    startTracking('s1')

    _tickAll()
    content = 'b'
    _tickAll()
    content = 'c'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'working' }])
  })

  it('cleans up on stopTracking', () => {
    startTracking('s1')
    stopTracking('s1')
    expect(_getState('s1')).toBeUndefined()
  })
})
