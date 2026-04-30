import { describe, expect, it } from 'vitest'
import { extractLinearIdentifier } from './linear-branch'

describe('extractLinearIdentifier', () => {
  it('extracts and uppercases a whole-branch identifier', () => {
    expect(extractLinearIdentifier('eng-4504')).toBe('ENG-4504')
  })

  it('extracts identifier from a Linear-style slug branch', () => {
    expect(extractLinearIdentifier('tedy/eng-4504-add-linear-icon')).toBe('ENG-4504')
  })

  it('extracts identifier preceded by a slash', () => {
    expect(extractLinearIdentifier('feat/eng-4504')).toBe('ENG-4504')
  })

  it('extracts identifier followed by a dash', () => {
    expect(extractLinearIdentifier('eng-4504-foo')).toBe('ENG-4504')
  })

  it('normalizes mixed case to uppercase', () => {
    expect(extractLinearIdentifier('Eng-4504')).toBe('ENG-4504')
    expect(extractLinearIdentifier('ENG-4504')).toBe('ENG-4504')
  })

  it('returns null for branches with no identifier', () => {
    expect(extractLinearIdentifier('main')).toBeNull()
    expect(extractLinearIdentifier('feature/no-id')).toBeNull()
    expect(extractLinearIdentifier('release-2026')).toBeNull()
  })

  it('rejects single-letter prefixes', () => {
    expect(extractLinearIdentifier('q-2-recap')).toBeNull()
    expect(extractLinearIdentifier('notes/q-2-recap')).toBeNull()
  })

  it('rejects mid-token false positives without boundaries', () => {
    expect(extractLinearIdentifier('releaseV2-2026')).toBeNull()
  })

  it('returns the first match when multiple identifiers exist', () => {
    expect(extractLinearIdentifier('tedy/eng-4504-fixes-dev-99')).toBe('ENG-4504')
  })

  it('returns null for empty string', () => {
    expect(extractLinearIdentifier('')).toBeNull()
  })
})
