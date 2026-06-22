import { describe, expect, it } from 'bun:test'
import { nextChunks } from './chunk-buffer'

describe('nextChunks', () => {
  it('concatenates new chunks in seq order', () => {
    const r = nextChunks([{ seq: 1, data: 'a' }, { seq: 2, data: 'b' }], 0)
    expect(r).toEqual({ data: 'ab', afterSeq: 2 })
  })
  it('skips already-seen seqs', () => {
    const r = nextChunks([{ seq: 1, data: 'a' }, { seq: 2, data: 'b' }, { seq: 3, data: 'c' }], 2)
    expect(r).toEqual({ data: 'c', afterSeq: 3 })
  })
  it('orders out-of-order input', () => {
    const r = nextChunks([{ seq: 3, data: 'c' }, { seq: 1, data: 'a' }, { seq: 2, data: 'b' }], 0)
    expect(r).toEqual({ data: 'abc', afterSeq: 3 })
  })
  it('returns empty + unchanged afterSeq when nothing new', () => {
    const r = nextChunks([{ seq: 1, data: 'a' }], 1)
    expect(r).toEqual({ data: '', afterSeq: 1 })
  })
  it('dedupes repeated seqs', () => {
    const r = nextChunks([{ seq: 1, data: 'a' }, { seq: 1, data: 'a' }], 0)
    expect(r).toEqual({ data: 'a', afterSeq: 1 })
  })
})
