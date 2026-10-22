import { describe, expect, it, vi } from 'vitest'

vi.mock('./runtime-state', () => ({
  getRemoteState: () => ({ workspaces: [{ trees: [{ rootDir: '/repo/main' }] }] }),
}))

import { assertMirroredRoot, checkBucket, parseAction, reviewDecisionOf, toTimeline } from './github'

describe('checkBucket', () => {
  it('maps check runs and commit statuses to the page buckets', () => {
    expect(checkBucket({ __typename: 'CheckRun', status: 'IN_PROGRESS' })).toBe('pending')
    expect(checkBucket({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('pass')
    expect(checkBucket({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' })).toBe('skipped')
    expect(checkBucket({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' })).toBe('action')
    expect(checkBucket({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'TIMED_OUT' })).toBe('fail')
    expect(checkBucket({ __typename: 'StatusContext', state: 'ERROR' })).toBe('fail')
    expect(checkBucket({ __typename: 'StatusContext', state: 'PENDING' })).toBe('pending')
  })
})

describe('reviewDecisionOf', () => {
  it('falls back to latest reviews when GitHub leaves the decision empty', () => {
    expect(reviewDecisionOf({ reviewDecision: '', latestReviews: [{ author: null, state: 'APPROVED' }] })).toBe('APPROVED')
    expect(
      reviewDecisionOf({
        reviewDecision: 'REVIEW_REQUIRED',
        latestReviews: [
          { author: null, state: 'APPROVED' },
          { author: null, state: 'CHANGES_REQUESTED' },
        ],
      }),
    ).toBe('CHANGES_REQUESTED')
    expect(reviewDecisionOf({ reviewDecision: 'REVIEW_REQUIRED', latestReviews: [] })).toBe('REVIEW_REQUIRED')
  })
})

describe('toTimeline', () => {
  it('keeps comments, reviews, commits and the events GitHub shows; drops the noise', () => {
    const items = toTimeline([
      { event: 'committed', sha: 'abcdef1234', message: 'feat: x\n\nbody', committer: { date: '2026-01-01' } },
      { event: 'subscribed', actor: { login: 'a' } },
      { event: 'commented', id: 1, user: { login: 'a' }, body_html: '<p>hi</p>', created_at: '2026-01-02' },
      { event: 'reviewed', id: 2, user: { login: 'b' }, state: 'approved', submitted_at: '2026-01-03' },
      { event: 'labeled', id: 3, actor: { login: 'c' }, label: { name: 'bug' }, created_at: '2026-01-04' },
    ])
    expect(items.map((i) => [i.kind, i.detail ?? i.reviewState ?? i.bodyHtml])).toEqual([
      ['commit', 'feat: x'],
      ['comment', '<p>hi</p>'],
      ['review', 'APPROVED'],
      ['event', 'bug'],
    ])
  })
})

describe('parseAction', () => {
  it('accepts known actions and rejects the rest', () => {
    expect(parseAction({ kind: 'merge', method: 'SQUASH', deleteBranch: true })).toEqual({
      kind: 'merge',
      method: 'SQUASH',
      deleteBranch: true,
      auto: false,
    })
    expect(() => parseAction({ kind: 'merge', method: 'OCTOPUS' })).toThrow()
    expect(() => parseAction({ kind: 'comment', body: '  ' })).toThrow()
    expect(() => parseAction({ kind: 'rm -rf' })).toThrow()
  })
})

describe('assertMirroredRoot', () => {
  it('only lets gh run in a worktree the phone can see', () => {
    expect(assertMirroredRoot('/repo/main')).toBe('/repo/main')
    expect(() => assertMirroredRoot('/etc')).toThrow('Unknown worktree')
  })
})
