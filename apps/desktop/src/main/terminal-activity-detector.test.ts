import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startTracking,
  stopTracking,
  initActivityDetector,
  stopActivityDetector,
  _getState,
  _tickAll,
} from './terminal-activity-detector'

describe('terminal-activity-detector', () => {
  let snapshotProvider: (sessionId: string) => string
  let emittedStates: { sessionId: string; state: 'working' | 'idle' }[]

  beforeEach(() => {
    snapshotProvider = vi.fn(() => '')
    emittedStates = []
    initActivityDetector({
      getSnapshot: snapshotProvider,
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
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
    startTracking('s1')

    // First tick: stores snapshot, no state change (still idle, first snapshot)
    _tickAll()
    expect(emittedStates).toEqual([])

    // Change content and tick again
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
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
      idleTimeoutMs: 100,
    })
    startTracking('s1')

    // Trigger working
    _tickAll()
    content = 'b'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'working' }])

    // Advance time past idle timeout without content change
    vi.advanceTimersByTime(150)
    _tickAll()
    expect(emittedStates).toEqual([
      { sessionId: 's1', state: 'working' },
      { sessionId: 's1', state: 'idle' },
    ])
    vi.useRealTimers()
  })

  it('does not emit duplicate states', () => {
    let content = 'a'
    snapshotProvider = vi.fn(() => content)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
    startTracking('s1')

    _tickAll()
    content = 'b'
    _tickAll() // working
    content = 'c'
    _tickAll() // still working, no duplicate emit
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'working' }])
  })

  it('cleans up on stopTracking', () => {
    startTracking('s1')
    stopTracking('s1')
    expect(_getState('s1')).toBeUndefined()
  })

  it('ignores ticks for untracked sessions', () => {
    _tickAll()
    expect(emittedStates).toEqual([])
  })
})
