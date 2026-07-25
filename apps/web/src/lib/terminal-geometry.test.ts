import { describe, expect, it } from 'vitest'
import { chooseGeometry, claimSettled, fitScale, isSaneGeometry, sameGeometry } from './terminal-geometry'

describe('isSaneGeometry', () => {
  it('accepts a positive finite grid', () => {
    expect(isSaneGeometry({ cols: 54, rows: 26 })).toBe(true)
  })

  it('rejects nothing, zero and garbage (mid-layout measurements)', () => {
    expect(isSaneGeometry(null)).toBe(false)
    expect(isSaneGeometry(undefined)).toBe(false)
    expect(isSaneGeometry({ cols: 0, rows: 26 })).toBe(false)
    expect(isSaneGeometry({ cols: 54, rows: 0 })).toBe(false)
    expect(isSaneGeometry({ cols: -1, rows: 26 })).toBe(false)
    expect(isSaneGeometry({ cols: Number.NaN, rows: 26 })).toBe(false)
    expect(isSaneGeometry({ cols: 54, rows: Number.POSITIVE_INFINITY })).toBe(false)
  })
})

describe('sameGeometry', () => {
  it('compares both dimensions and treats absence as different', () => {
    expect(sameGeometry({ cols: 54, rows: 26 }, { cols: 54, rows: 26 })).toBe(true)
    expect(sameGeometry({ cols: 54, rows: 26 }, { cols: 54, rows: 25 })).toBe(false)
    expect(sameGeometry(null, null)).toBe(false)
  })
})

describe('chooseGeometry', () => {
  const mirrored = { cols: 150, rows: 40 }
  const pending = { cols: 54, rows: 26 }

  it('renders at the size we just claimed, so a seed that lands first matches', () => {
    expect(chooseGeometry(mirrored, pending)).toEqual(pending)
  })

  it('renders at the bridge geometry once no claim is outstanding', () => {
    expect(chooseGeometry(mirrored, null)).toEqual(mirrored)
  })

  it('defers to the caller only before the bridge has said anything', () => {
    expect(chooseGeometry(null, null)).toBeNull()
    expect(chooseGeometry(undefined, undefined)).toBeNull()
  })

  it('skips unusable candidates rather than rendering at a garbage size', () => {
    expect(chooseGeometry(mirrored, { cols: 0, rows: 0 })).toEqual(mirrored)
    expect(chooseGeometry({ cols: 0, rows: 0 }, null)).toBeNull()
  })
})

describe('claimSettled', () => {
  const pending = { cols: 54, rows: 26 }

  it('is settled once the bridge echoes the claimed size back', () => {
    expect(claimSettled(pending, { cols: 54, rows: 26 })).toBe(true)
  })

  it('stays outstanding while the bridge still reports the old size', () => {
    expect(claimSettled(pending, { cols: 150, rows: 40 })).toBe(false)
    expect(claimSettled(pending, null)).toBe(false)
  })

  it('is trivially settled with no claim outstanding', () => {
    expect(claimSettled(null, { cols: 150, rows: 40 })).toBe(true)
  })
})

describe('fitScale', () => {
  it('never magnifies a grid that already fits', () => {
    expect(fitScale({ width: 421, height: 442 }, { width: 430, height: 460 })).toBe(1)
  })

  it('shrinks by the tighter axis so the bottom row is never clipped', () => {
    expect(fitScale({ width: 1200, height: 800 }, { width: 600, height: 600 })).toBe(0.5)
    expect(fitScale({ width: 800, height: 1200 }, { width: 600, height: 600 })).toBe(0.5)
  })

  it('is a no-op when either box has not been laid out yet', () => {
    expect(fitScale({ width: 0, height: 800 }, { width: 600, height: 600 })).toBe(1)
    expect(fitScale({ width: 800, height: 800 }, { width: 600, height: 0 })).toBe(1)
  })
})
