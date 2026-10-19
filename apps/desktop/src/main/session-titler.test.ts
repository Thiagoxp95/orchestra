import { describe, expect, it } from 'vitest'
import { buildTitleRequest, sanitizeTitle } from './session-titler'

describe('sanitizeTitle', () => {
  it('keeps a clean title', () => {
    expect(sanitizeTitle('Optimizing keyboard layout\n')).toBe('Optimizing keyboard layout')
  })

  it('strips quotes, labels and trailing punctuation', () => {
    expect(sanitizeTitle('"Fixing Fold standby display."')).toBe('Fixing Fold standby display')
    expect(sanitizeTitle('Title: Shipping session titles')).toBe('Shipping session titles')
    expect(sanitizeTitle('**Debugging push alerts**')).toBe('Debugging push alerts')
  })

  it('rejects replies that are not a title', () => {
    expect(sanitizeTitle('')).toBe('')
    expect(sanitizeTitle('I think this session is about fixing the keyboard on the phone')).toBe('')
  })
})

describe('buildTitleRequest', () => {
  it('carries the current title so it can roll forward', () => {
    expect(buildTitleRequest('yes do it', 'Fixing sidebar titles')).toContain('Current title: Fixing sidebar titles')
    expect(buildTitleRequest('hello', undefined)).toContain('(none yet)')
  })
})
