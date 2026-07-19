import { describe, expect, it } from 'vitest'
import { maxSeq, orderChunks } from './dictation-chunks'

describe('orderChunks', () => {
  it('sorts ascending, drops <= afterSeq, and de-dups by seq', () => {
    const rows = [
      { seq: 3, pcm: 'c' },
      { seq: 1, pcm: 'a' },
      { seq: 3, pcm: 'c-dup' },
      { seq: 2, pcm: 'b' },
      { seq: 0, pcm: 'old' },
    ]
    expect(orderChunks(rows, 0)).toEqual([
      { seq: 1, pcm: 'a' },
      { seq: 2, pcm: 'b' },
      { seq: 3, pcm: 'c' },
    ])
  })
})

describe('maxSeq', () => {
  it('returns the highest seq', () => {
    expect(maxSeq([{ seq: 1, pcm: 'a' }, { seq: 5, pcm: 'e' }], -1)).toBe(5)
  })
  it('returns the fallback when empty', () => {
    expect(maxSeq([], -1)).toBe(-1)
  })
})
