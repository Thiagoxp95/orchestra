import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createOutputBatcher } from './remote-bridge-batcher'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createOutputBatcher', () => {
  it('coalesces pushes and flushes after flushMs', () => {
    const flushes: string[] = []
    const b = createOutputBatcher({ flushMs: 50, maxBytes: 1000, onFlush: (d) => flushes.push(d) })
    b.push('a'); b.push('b'); b.push('c')
    expect(flushes).toEqual([])
    vi.advanceTimersByTime(50)
    expect(flushes).toEqual(['abc'])
  })
  it('flushes immediately when maxBytes exceeded', () => {
    const flushes: string[] = []
    const b = createOutputBatcher({ flushMs: 50, maxBytes: 3, onFlush: (d) => flushes.push(d) })
    b.push('ab'); b.push('cd')
    expect(flushes).toEqual(['abcd'])
  })
  it('does not flush empty buffers', () => {
    const flushes: string[] = []
    const b = createOutputBatcher({ flushMs: 50, maxBytes: 1000, onFlush: (d) => flushes.push(d) })
    b.flush()
    vi.advanceTimersByTime(100)
    expect(flushes).toEqual([])
  })
  it('dispose cancels a pending flush', () => {
    const flushes: string[] = []
    const b = createOutputBatcher({ flushMs: 50, maxBytes: 1000, onFlush: (d) => flushes.push(d) })
    b.push('x'); b.dispose()
    vi.advanceTimersByTime(100)
    expect(flushes).toEqual([])
  })
})
