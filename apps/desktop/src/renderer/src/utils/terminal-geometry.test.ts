import { describe, expect, it } from 'vitest'
import {
  isSaneGeometry,
  geometryChanged,
  nudgeRows,
  planPtyResize,
  type Geometry,
} from './terminal-geometry'

describe('isSaneGeometry', () => {
  const cases: Array<[string, Geometry, boolean]> = [
    ['typical 80x24', { cols: 80, rows: 24 }, true],
    ['xterm floor 2x1', { cols: 2, rows: 1 }, true],
    ['1 col is below xterm floor', { cols: 1, rows: 24 }, false],
    ['0 rows', { cols: 80, rows: 0 }, false],
    ['0x0', { cols: 0, rows: 0 }, false],
    ['negative cols', { cols: -5, rows: 10 }, false],
    ['NaN cols', { cols: Number.NaN, rows: 24 }, false],
    ['Infinity rows', { cols: 80, rows: Number.POSITIVE_INFINITY }, false],
    ['non-integer cols', { cols: 80.5, rows: 24 }, false],
    ['absurdly large cols (corruption upper bound)', { cols: 5000, rows: 24 }, false],
    ['absurdly large rows', { cols: 80, rows: 5000 }, false],
  ]
  it.each(cases)('%s', (_label, geo, expected) => {
    expect(isSaneGeometry(geo)).toBe(expected)
  })
})

describe('geometryChanged', () => {
  it('treats null/undefined previous as changed (first sync)', () => {
    expect(geometryChanged(null, { cols: 80, rows: 24 })).toBe(true)
    expect(geometryChanged(undefined, { cols: 80, rows: 24 })).toBe(true)
  })
  it('identical geometry is unchanged', () => {
    expect(geometryChanged({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(false)
  })
  it('differing rows or cols is changed', () => {
    expect(geometryChanged({ cols: 80, rows: 24 }, { cols: 80, rows: 25 })).toBe(true)
    expect(geometryChanged({ cols: 80, rows: 24 }, { cols: 81, rows: 24 })).toBe(true)
  })
})

describe('nudgeRows', () => {
  it('shrinks by one when above the floor', () => {
    expect(nudgeRows(24)).toBe(23)
    expect(nudgeRows(2)).toBe(1)
  })
  it('grows by one at the floor so the value always changes', () => {
    expect(nudgeRows(1)).toBe(2)
  })
})

describe('planPtyResize', () => {
  it('never propagates a corrupt fit', () => {
    expect(planPtyResize({ last: null, next: { cols: 1, rows: 1 } })).toEqual([])
    expect(planPtyResize({ last: { cols: 80, rows: 24 }, next: { cols: 0, rows: 0 } })).toEqual([])
  })

  it('first sync sends the target size directly', () => {
    expect(planPtyResize({ last: null, next: { cols: 80, rows: 24 } })).toEqual([
      { cols: 80, rows: 24, settleMs: 0 },
    ])
  })

  it('a real size change sends the new size directly (the delta itself delivers SIGWINCH)', () => {
    expect(
      planPtyResize({ last: { cols: 80, rows: 24 }, next: { cols: 120, rows: 40 } }),
    ).toEqual([{ cols: 120, rows: 40, settleMs: 0 }])
  })

  it('same size without forceRepaint is an inert no-op', () => {
    expect(
      planPtyResize({ last: { cols: 80, rows: 24 }, next: { cols: 80, rows: 24 } }),
    ).toEqual([])
  })

  it('same size with forceRepaint nudges to force a clean repaint (clears ghost/duplicate lines)', () => {
    expect(
      planPtyResize({
        last: { cols: 80, rows: 24 },
        next: { cols: 80, rows: 24 },
        forceRepaint: true,
        nudgeSettleMs: 60,
      }),
    ).toEqual([
      { cols: 80, rows: 23, settleMs: 60 },
      { cols: 80, rows: 24, settleMs: 0 },
    ])
  })

  it('a real size change does not nudge even under forceRepaint (the change already repaints)', () => {
    expect(
      planPtyResize({
        last: { cols: 80, rows: 24 },
        next: { cols: 120, rows: 40 },
        forceRepaint: true,
      }),
    ).toEqual([{ cols: 120, rows: 40, settleMs: 0 }])
  })

  it('forceRepaint on first sync (no last) just sends the size, nothing to repaint over', () => {
    expect(
      planPtyResize({ last: null, next: { cols: 80, rows: 24 }, forceRepaint: true }),
    ).toEqual([{ cols: 80, rows: 24, settleMs: 0 }])
  })
})
