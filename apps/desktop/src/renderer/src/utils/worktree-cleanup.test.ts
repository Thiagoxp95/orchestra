import { describe, expect, it } from 'vitest'
import { isWorktreeCleanupEligible } from './worktree-cleanup'

describe('isWorktreeCleanupEligible', () => {
  it('never removes the main repo (index 0), even when its PR is merged', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 0, pr: { state: 'MERGED' } })).toBe(false)
  })

  it('is eligible when the PR is closed or merged', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 1, pr: { state: 'CLOSED' } })).toBe(true)
    expect(isWorktreeCleanupEligible({ treeIndex: 1, pr: { state: 'MERGED' } })).toBe(true)
    expect(isWorktreeCleanupEligible({ treeIndex: 1, pr: { state: 'merged' } })).toBe(true)
  })

  it('is not eligible for open or draft PRs', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 1, pr: { state: 'OPEN' } })).toBe(false)
    expect(isWorktreeCleanupEligible({ treeIndex: 1, pr: { state: 'DRAFT' } })).toBe(false)
  })

  it('is eligible when the Linear ticket is in staging or production (case-insensitive)', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: 'Staging' } } })).toBe(true)
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: 'production' } } })).toBe(true)
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: ' Production ' } } })).toBe(true)
  })

  it('is not eligible for other Linear states', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: 'In Progress' } } })).toBe(false)
  })

  it('is eligible if either condition holds (PR merged even when Linear is not done)', () => {
    expect(isWorktreeCleanupEligible({
      treeIndex: 3,
      pr: { state: 'MERGED' },
      linearIssue: { state: { name: 'In Progress' } },
    })).toBe(true)
  })

  it('is not eligible with no PR and no Linear ticket', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 4 })).toBe(false)
  })
})
