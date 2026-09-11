import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createOutputBatcher } from './remote-bridge-batcher'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createOutputBatcher', () => {
  it('sends the first interactive echo immediately and coalesces only its trailing burst', () => {
    const flushes: { data: string; at: number }[] = []
    const started = Date.now()
    const b = createOutputBatcher({ flushMs: 16, maxBytes: 1000, leading: true, onFlush: data => flushes.push({ data, at: Date.now() - started }) })
    b.push('a')
    expect(flushes).toEqual([{ data: 'a', at: 0 }])
    vi.advanceTimersByTime(4)
    b.push('b')
    b.push('c')
    vi.advanceTimersByTime(12)
    expect(flushes).toEqual([{ data: 'a', at: 0 }, { data: 'bc', at: 16 }])
    vi.advanceTimersByTime(100)
    b.push('d')
    expect(flushes.at(-1)).toEqual({ data: 'd', at: 116 })
  })

  it('keeps continuous output bounded to its flush cadence, then flushes before detach', () => {
    const flushes: string[] = []
    const b = createOutputBatcher({ flushMs: 16, maxBytes: 1000, leading: true, onFlush: data => flushes.push(data) })
    for (let i = 0; i < 50; i++) { b.push('x'); vi.advanceTimersByTime(1) }
    b.flush()
    b.dispose()
    expect(flushes.join('')).toBe('x'.repeat(50))
    expect(flushes).toHaveLength(5)
    vi.advanceTimersByTime(100)
    expect(flushes).toHaveLength(5)
  })

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
