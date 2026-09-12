import { describe, expect, it } from 'vitest'
import { nextChunks } from './chunk-buffer'

describe('nextChunks', () => {
  it('requires a snapshot before applying retained animation updates to a new terminal', () => {
    const r = nextChunks([{ seq: 12832, data: '\x1b[2A\x1b[10Cdeterministic replay' }], -1)
    expect(r).toEqual({ data: '', afterSeq: -1, reset: false, needsSeed: true })
  })

  it('rejects a batch with missing output without advancing past the gap', () => {
    const r = nextChunks([{ seq: 11, data: 'before' }, { seq: 13, data: '\x1b[Aafter' }], 10)
    expect(r).toEqual({ data: '', afterSeq: 10, reset: false, needsSeed: true })
  })

  it('recovers across missing history using the latest complete snapshot', () => {
    const r = nextChunks([
      { seq: 13, data: 'stale' },
      { seq: 20, data: 'SCREEN', seed: true },
      { seq: 21, data: 'live' },
    ], 10)
    expect(r).toEqual({ data: 'SCREENlive', afterSeq: 21, reset: true })
  })

  it('requires another snapshot when output is missing after the seed', () => {
    const r = nextChunks([{ seq: 20, data: 'SCREEN', seed: true }, { seq: 22, data: 'tail' }], -1)
    expect(r).toEqual({ data: '', afterSeq: -1, reset: false, needsSeed: true })
  })

  it('concatenates new chunks in seq order', () => {
    const r = nextChunks([{ seq: 1, data: 'a' }, { seq: 2, data: 'b' }], 0)
    expect(r).toEqual({ data: 'ab', afterSeq: 2, reset: false })
  })
  it('skips already-seen seqs', () => {
    const r = nextChunks([{ seq: 1, data: 'a' }, { seq: 2, data: 'b' }, { seq: 3, data: 'c' }], 2)
    expect(r).toEqual({ data: 'c', afterSeq: 3, reset: false })
  })
  it('orders out-of-order input', () => {
    const r = nextChunks([{ seq: 3, data: 'c' }, { seq: 1, data: 'a' }, { seq: 2, data: 'b' }], 0)
    expect(r).toEqual({ data: 'abc', afterSeq: 3, reset: false })
  })
  it('returns empty + unchanged afterSeq when nothing new', () => {
    const r = nextChunks([{ seq: 1, data: 'a' }], 1)
    expect(r).toEqual({ data: '', afterSeq: 1, reset: false })
  })
  it('dedupes repeated seqs', () => {
    const r = nextChunks([{ seq: 1, data: 'a' }, { seq: 1, data: 'a' }], 0)
    expect(r).toEqual({ data: 'a', afterSeq: 1, reset: false })
  })

  it('signals reset and starts from the seed chunk, dropping pre-seed bytes', () => {
    // A re-seed lands above the cursor: the seed wipes the screen, so any bytes
    // queued before it in the same batch must be discarded.
    const r = nextChunks(
      [
        { seq: 5, data: 'stale' },
        { seq: 6, data: 'SEED', seed: true },
        { seq: 7, data: 'live' },
      ],
      4,
    )
    expect(r).toEqual({ data: 'SEEDlive', afterSeq: 7, reset: true })
  })

  it('a lone seed chunk resets and replays just the snapshot', () => {
    const r = nextChunks([{ seq: 42, data: 'SNAP', seed: true }], 41)
    expect(r).toEqual({ data: 'SNAP', afterSeq: 42, reset: true })
  })

  it('the last seed in a batch wins', () => {
    const r = nextChunks(
      [
        { seq: 1, data: 'A', seed: true },
        { seq: 2, data: 'mid' },
        { seq: 3, data: 'B', seed: true },
        { seq: 4, data: 'tail' },
      ],
      0,
    )
    expect(r).toEqual({ data: 'Btail', afterSeq: 4, reset: true })
  })

  it('does not reset when the seed is at or below the cursor (already applied)', () => {
    const r = nextChunks(
      [
        { seq: 1, data: 'A', seed: true },
        { seq: 2, data: 'live' },
      ],
      1,
    )
    expect(r).toEqual({ data: 'live', afterSeq: 2, reset: false })
  })
})
