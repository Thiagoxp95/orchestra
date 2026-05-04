import { describe, expect, it } from 'vitest'
import { getWorktreeDisplayLabel } from './worktree-display'

describe('getWorktreeDisplayLabel', () => {
  it('keeps the Linear ticket identifier visible when a display name is set', () => {
    expect(getWorktreeDisplayLabel('eng-4547', 'Fix submission flow')).toBe('ENG-4547 · Fix submission flow')
    expect(getWorktreeDisplayLabel('tedy/eng-4502-stripe-prices-mirror', 'Stripe mirror')).toBe('ENG-4502 · Stripe mirror')
  })

  it('uses the display name by itself when the branch has no ticket identifier', () => {
    expect(getWorktreeDisplayLabel('staging', 'Release staging')).toBe('Release staging')
  })

  it('falls back to the branch when display name is blank or missing', () => {
    expect(getWorktreeDisplayLabel('eng-4547', '')).toBe('eng-4547')
    expect(getWorktreeDisplayLabel('eng-4547', '   ')).toBe('eng-4547')
    expect(getWorktreeDisplayLabel('eng-4547')).toBe('eng-4547')
  })
})
