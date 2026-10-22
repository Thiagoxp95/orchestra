import { describe, expect, it } from 'vitest'
import {
  authorKey,
  chooseMergeMethod,
  mergeSeenAuthors,
  groupPulls,
  parseDiff,
  primaryControl,
  searchScore,
  sortPulls,
  type PullDetail,
  type PullSummary,
} from './github'

const pr = (over: Partial<PullSummary> = {}): PullSummary => ({
  number: 1,
  title: 'Fix the thing',
  state: 'OPEN',
  url: 'https://github.com/o/r/pull/1',
  author: { login: 'me', avatarUrl: '' },
  headRefName: 'fix/thing',
  baseRefName: 'main',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  labels: [],
  reviewRequests: [],
  checks: { pass: 3, fail: 0, pending: 0, skipped: 0, action: 0 },
  reviewRequested: false,
  ...over,
})

const detail = (over: Partial<PullDetail> = {}): PullDetail => ({
  ...pr(),
  bodyHtml: '',
  commits: 1,
  assignees: [],
  reviewers: [],
  checkList: [],
  files: [],
  timeline: [],
  repo: {
    nameWithOwner: 'o/r',
    url: '',
    defaultBranch: 'main',
    viewerLogin: 'me',
    viewerPermission: 'WRITE',
    mergeMethods: ['SQUASH', 'MERGE'],
    defaultMergeMethod: 'SQUASH',
    deleteBranchOnMerge: false,
  },
  viewerIsAuthor: true,
  isCrossRepository: false,
  ...over,
})

describe('groupPulls', () => {
  it('orders Authored, Review requested, Others and drops empty groups', () => {
    const groups = groupPulls(
      [
        pr({ number: 1, author: { login: 'them', avatarUrl: '' } }),
        pr({ number: 2 }),
        pr({ number: 3, author: { login: 'x', avatarUrl: '' }, reviewRequested: true }),
      ],
      'me',
      'all',
    )
    expect(groups.map((g) => [g.key, g.pulls.map((p) => p.number)])).toEqual([
      ['authored', [2]],
      ['reviewRequested', [3]],
      ['others', [1]],
    ])
  })
  it('is one unlabeled group under a narrower involvement', () => {
    expect(groupPulls([pr()], 'me', 'authored')).toEqual([{ key: null, pulls: [pr()] }])
  })
})

describe('sortPulls ready', () => {
  it('approved+passing, passing, rest, closed, conflicting', () => {
    const sorted = sortPulls(
      [
        pr({ number: 5, mergeable: 'CONFLICTING' }),
        pr({ number: 4, state: 'CLOSED' }),
        pr({ number: 3, checks: { pass: 0, fail: 1, pending: 0, skipped: 0, action: 0 } }),
        pr({ number: 2 }),
        pr({ number: 1, reviewDecision: 'APPROVED' }),
      ],
      'ready',
      'me',
    )
    expect(sorted.map((p) => p.number)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('searchScore', () => {
  it('ranks an exact number above a title hit and rejects misses', () => {
    expect(searchScore(pr({ number: 42 }), '#42')).toBe(100)
    expect(searchScore(pr(), 'thing')).toBe(80)
    expect(searchScore(pr(), 'nothing-here')).toBe(0)
  })
})

describe('primaryControl', () => {
  it('follows the state ladder', () => {
    expect(primaryControl(detail({ state: 'MERGED' }))).toBe('merged')
    expect(primaryControl(detail({ mergeable: 'CONFLICTING' }))).toBe('resolve')
    expect(primaryControl(detail({ state: 'DRAFT' }))).toBe('ready')
    expect(primaryControl(detail({ autoMerge: { method: 'SQUASH' } }))).toBe('auto-merge-armed')
    expect(primaryControl(detail({ checks: { pass: 1, fail: 0, pending: 2, skipped: 0, action: 0 } }))).toBe(
      'enable-auto-merge',
    )
    expect(primaryControl(detail())).toBe('merge')
    expect(primaryControl(detail({ repo: { ...detail().repo, viewerPermission: 'READ' } }))).toBe(null)
  })
})

describe('chooseMergeMethod', () => {
  it('prefers the armed method, then the last used, then the repo default, if allowed', () => {
    expect(chooseMergeMethod(detail({ autoMerge: { method: 'MERGE' } }), 'SQUASH')).toBe('MERGE')
    expect(chooseMergeMethod(detail(), 'MERGE')).toBe('MERGE')
    expect(chooseMergeMethod(detail(), 'REBASE')).toBe('SQUASH')
  })
})

describe('parseDiff', () => {
  it('numbers lines per hunk and counts changes', () => {
    const files = parseDiff(
      [
        'diff --git a/a.ts b/a.ts',
        'index 1..2 100644',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,3 +1,3 @@',
        ' one',
        '-two',
        '+TWO',
        ' three',
        'diff --git a/new.ts b/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1 @@',
        '+hi',
        '',
      ].join('\n'),
    )
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['a.ts', 'modified', 1, 1],
      ['new.ts', 'added', 1, 0],
    ])
    expect(files[0].lines.slice(1).map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['ctx', 1, 1],
      ['del', 2, undefined],
      ['add', undefined, 2],
      ['ctx', 3, 3],
    ])
    expect(files[1].lines).toHaveLength(2)
  })
})

describe('authors', () => {
  it('keys bots as app/ and keeps remembered authors behind the fresh ones', () => {
    expect(authorKey({ login: 'dependabot', isBot: true })).toBe('app/dependabot')
    const seen = [
      { login: 'old', avatarUrl: '' },
      { login: 'me', avatarUrl: 'stale' },
    ]
    const merged = mergeSeenAuthors(seen, [pr({ author: { login: 'me', avatarUrl: 'fresh' } })])
    expect(merged.map((u) => [u.login, u.avatarUrl])).toEqual([
      ['me', 'fresh'],
      ['old', ''],
    ])
  })
})
