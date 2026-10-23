import { describe, expect, it, vi } from 'vitest'

vi.mock('./runtime-state', () => ({
  getRemoteState: () => ({ workspaces: [{ trees: [{ rootDir: '/repo/main' }] }] }),
}))

import { assertMirroredRoot, checkBucket, parseAction, parseAuthors, parseRepo, remoteRepo, reviewDecisionOf, searchNodeToSummary, toTimeline } from './github'

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

describe('searchNodeToSummary', () => {
  it('maps a GraphQL search node, counting the rollup as one check', () => {
    const pr = searchNodeToSummary(
      {
        number: 7,
        title: 't',
        url: 'u',
        state: 'OPEN',
        isDraft: true,
        headRefName: 'h',
        baseRefName: 'b',
        createdAt: '',
        updatedAt: '',
        additions: 1,
        deletions: 2,
        changedFiles: 1,
        reviewDecision: null,
        mergeable: 'MERGEABLE',
        author: { login: 'me', avatarUrl: 'https://a/me.png' },
        labels: { nodes: [] },
        reviewRequests: { nodes: [{ requestedReviewer: { login: 'me' } }, { requestedReviewer: null }] },
        latestReviews: { nodes: [{ state: 'APPROVED', author: { login: 'x' } }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
      },
      'me',
    )
    expect(pr).toMatchObject({
      state: 'DRAFT',
      reviewDecision: 'APPROVED',
      reviewRequested: true,
      reviewRequests: ['me'],
      author: { login: 'me', avatarUrl: 'https://a/me.png' },
      checks: { fail: 1, pass: 0, pending: 0 },
    })
  })
})

describe('parseAuthors', () => {
  it('keeps logins and app/ bots, drops anything that could smuggle a qualifier', () => {
    expect(parseAuthors(['Thiagoxp95', 'app/dependabot', 'a b', 'x repo:evil/r', 'no:colon', 3])).toEqual([
      'Thiagoxp95',
      'app/dependabot',
    ])
    expect(parseAuthors('nope')).toEqual([])
  })
})

describe('remoteRepo', () => {
  it('reads owner/name from https and ssh remotes', () => {
    expect(remoteRepo('https://github.com/tedy-app/tedy.git\n')).toBe('tedy-app/tedy')
    expect(remoteRepo('git@github.com:Tedy-App/tedy-9000.git')).toBe('tedy-app/tedy-9000')
    expect(remoteRepo('https://github.com/a/b')).toBe('a/b')
    expect(remoteRepo('https://gitlab.com/a/b.git')).toBeNull()
  })

  it('accepts only owner/name as a repo argument', () => {
    expect(parseRepo('tedy-app/tedy')).toBe('tedy-app/tedy')
    expect(() => parseRepo('../etc')).toThrow()
    expect(() => parseRepo('a/b/c')).toThrow()
  })
})
