// lib/github.ts
//
// The pull-request page's data shapes and every rule that decides what it
// shows. The shapes mirror the desktop's local-server/github.ts (which answers
// from the user's own `gh` login); the rules follow t3code's PR page — the
// list's grouping and "merge readiness" sort, and the one primary button the
// detail header offers for each state.

export type PullState = 'OPEN' | 'DRAFT' | 'MERGED' | 'CLOSED'
export type MergeMethod = 'MERGE' | 'SQUASH' | 'REBASE'
export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipped' | 'action'
export type ReviewDecision = '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'

export interface GitHubUser {
  login: string
  name?: string
  avatarUrl: string
  isBot?: boolean
}

export interface GitHubRepo {
  nameWithOwner: string
  url: string
  defaultBranch: string
  viewerLogin: string
  viewerPermission: string
  mergeMethods: MergeMethod[]
  defaultMergeMethod: MergeMethod
  deleteBranchOnMerge: boolean
}

export interface CheckSummary {
  pass: number
  fail: number
  pending: number
  skipped: number
  action: number
}

export interface PullSummary {
  number: number
  title: string
  state: PullState
  url: string
  author: GitHubUser
  headRefName: string
  baseRefName: string
  createdAt: string
  updatedAt: string
  additions: number
  deletions: number
  changedFiles: number
  reviewDecision: ReviewDecision
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string
  labels: { name: string; color: string }[]
  reviewRequests: string[]
  checks: CheckSummary
  reviewRequested: boolean
}

export interface GitHubCheck {
  name: string
  workflow?: string
  bucket: CheckBucket
  url?: string
  startedAt?: string
  completedAt?: string
}

export interface TimelineItem {
  id: string
  kind: 'comment' | 'review' | 'commit' | 'event'
  event?: string
  actor?: GitHubUser
  createdAt: string
  bodyHtml?: string
  reviewState?: string
  url?: string
  detail?: string
  sha?: string
}

export interface PullReviewer {
  user: GitHubUser
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING' | 'REQUESTED'
}

export interface PullDetail extends PullSummary {
  bodyHtml: string
  mergedAt?: string
  closedAt?: string
  mergedBy?: GitHubUser
  commits: number
  assignees: GitHubUser[]
  reviewers: PullReviewer[]
  checkList: GitHubCheck[]
  autoMerge?: { method: MergeMethod; enabledBy?: string }
  files: { path: string; additions: number; deletions: number }[]
  timeline: TimelineItem[]
  repo: GitHubRepo
  viewerIsAuthor: boolean
  isCrossRepository: boolean
}

export type PullAction =
  | { kind: 'merge'; method: MergeMethod; deleteBranch: boolean; auto?: boolean }
  | { kind: 'disableAutoMerge' }
  | { kind: 'approve'; body?: string }
  | { kind: 'requestChanges'; body: string }
  | { kind: 'comment'; body: string }
  | { kind: 'close' }
  | { kind: 'reopen' }
  | { kind: 'ready' }
  | { kind: 'draft' }
  | { kind: 'updateBranch' }
  | { kind: 'deleteBranch' }

export type StateFilter = 'open' | 'closed' | 'merged' | 'all'
export type Involvement = 'all' | 'reviewing' | 'authored'
export type PullSort = 'ready' | 'blocked' | 'updated' | 'newest' | 'oldest' | 'largest' | 'smallest'

export const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  MERGE: 'Merge',
  SQUASH: 'Squash and merge',
  REBASE: 'Rebase and merge',
}

export const SORT_LABEL: Record<PullSort, string> = {
  ready: 'Merge readiness',
  blocked: 'Blocked on me',
  updated: 'Recently updated',
  newest: 'Newest',
  oldest: 'Oldest',
  largest: 'Largest',
  smallest: 'Smallest',
}

/** What an action did, worded for the toast. */
export const ACTION_DONE: Record<PullAction['kind'], string> = {
  merge: 'Merge requested',
  disableAutoMerge: 'Auto-merge disabled',
  approve: 'Pull request approved',
  requestChanges: 'Changes requested',
  comment: 'Comment posted',
  close: 'Pull request closed',
  reopen: 'Pull request reopened',
  ready: 'Marked ready for review',
  draft: 'Converted to draft',
  updateBranch: 'Branch updated with the base branch',
  deleteBranch: 'Branch deleted',
}

// ── Authors ──────────────────────────────────────────────────────────────

/** The `author:` value GitHub search wants: bots go by `app/<name>`. */
export function authorKey(u: Pick<GitHubUser, 'login' | 'isBot'>): string {
  return u.isBot ? `app/${u.login}` : u.login
}

/**
 * Everyone the author picker can offer: the authors already remembered for this
 * repo plus whoever wrote a PR in the list just loaded, newest-seen first.
 * Remembered, because once a filter is on the list only holds those authors —
 * the rest would vanish from the picker the moment you used it.
 */
export function mergeSeenAuthors(seen: GitHubUser[], pulls: Pick<PullSummary, 'author'>[], cap = 200): GitHubUser[] {
  const out = new Map<string, GitHubUser>()
  for (const p of pulls) out.set(authorKey(p.author), p.author)
  for (const u of seen) if (!out.has(authorKey(u))) out.set(authorKey(u), u)
  return [...out.values()].slice(0, cap)
}

// ── Checks ───────────────────────────────────────────────────────────────

export type ChecksOverall = 'failing' | 'pending' | 'passing' | null

export function checksOverall(c: CheckSummary): ChecksOverall {
  if (c.fail > 0) return 'failing'
  if (c.pending > 0 || c.action > 0) return 'pending'
  if (c.pass > 0) return 'passing'
  return null
}

export function checksSummaryText(c: CheckSummary): string {
  const total = c.pass + c.fail + c.pending + c.skipped + c.action
  if (total === 0) return 'No checks reported'
  if (c.fail > 0) return `${c.fail} of ${total} failing`
  if (c.pending > 0) return `${c.pending} of ${total} running`
  if (c.action > 0) return `${c.action} awaiting approval`
  return 'All checks passed'
}

// ── List ─────────────────────────────────────────────────────────────────

export type PullGroupKey = 'authored' | 'reviewRequested' | 'others'

export const GROUP_LABEL: Record<PullGroupKey, string> = {
  authored: 'Authored',
  reviewRequested: 'Review requested',
  others: 'Others',
}

export function pullGroup(pr: Pick<PullSummary, 'author' | 'reviewRequested'>, viewer: string): PullGroupKey {
  if (pr.author.login === viewer) return 'authored'
  if (pr.reviewRequested) return 'reviewRequested'
  return 'others'
}

/** Authored → Review requested → Others, empty groups dropped. One unlabeled group outside "All". */
export function groupPulls<T extends Pick<PullSummary, 'author' | 'reviewRequested'>>(
  pulls: T[],
  viewer: string,
  involvement: Involvement,
): { key: PullGroupKey | null; pulls: T[] }[] {
  if (involvement !== 'all') return pulls.length ? [{ key: null, pulls }] : []
  const order: PullGroupKey[] = ['authored', 'reviewRequested', 'others']
  return order
    .map((key) => ({ key, pulls: pulls.filter((p) => pullGroup(p, viewer) === key) }))
    .filter((g) => g.pulls.length > 0)
}

/** t3code's "merge readiness" tier: smaller sorts first. */
export function readinessTier(pr: PullSummary): number {
  if (pr.mergeable === 'CONFLICTING') return 4
  if (pr.state !== 'OPEN' && pr.state !== 'DRAFT') return 3
  if (pr.state === 'DRAFT') return 2
  const checks = checksOverall(pr.checks)
  if (checks === 'passing' && pr.reviewDecision === 'APPROVED') return 0
  if (checks === 'passing') return 1
  return 2
}

/** "Blocked on me": my PRs in the order I have to act on them; asks of me first among the rest. */
export function blockedTier(pr: PullSummary, viewer: string): number {
  if (pr.author.login === viewer) {
    if (pr.state !== 'OPEN' && pr.state !== 'DRAFT') return 6
    if (pr.mergeable === 'CONFLICTING') return 0
    if (pr.reviewDecision === 'CHANGES_REQUESTED') return 1
    if (checksOverall(pr.checks) === 'failing') return 2
    if (pr.state === 'DRAFT') return 3
    if (pr.reviewDecision === 'APPROVED' && checksOverall(pr.checks) === 'passing') return 5
    return 4
  }
  return pr.state === 'OPEN' || pr.state === 'DRAFT' ? 4 : 6
}

const size = (p: PullSummary) => p.additions + p.deletions
const updated = (p: PullSummary) => Date.parse(p.updatedAt) || 0
const created = (p: PullSummary) => Date.parse(p.createdAt) || 0

export function sortPulls(pulls: PullSummary[], sort: PullSort, viewer: string): PullSummary[] {
  const out = [...pulls]
  switch (sort) {
    case 'ready':
      return out.sort((a, b) => readinessTier(a) - readinessTier(b) || size(a) - size(b) || updated(b) - updated(a))
    case 'blocked':
      return out.sort((a, b) => blockedTier(a, viewer) - blockedTier(b, viewer) || updated(b) - updated(a))
    case 'updated':
      return out.sort((a, b) => updated(b) - updated(a))
    case 'newest':
      return out.sort((a, b) => created(b) - created(a))
    case 'oldest':
      return out.sort((a, b) => created(a) - created(b))
    case 'largest':
      return out.sort((a, b) => size(b) - size(a))
    case 'smallest':
      return out.sort((a, b) => size(a) - size(b))
  }
}

/** Local match score, t3code's ladder: number, title, branch, author, then any word. 0 = no match. */
export function searchScore(pr: PullSummary, query: string): number {
  const q = query.trim().toLowerCase().replace(/^#/, '')
  if (!q) return 1
  const title = pr.title.toLowerCase()
  const words = q.split(/\s+/).filter(Boolean)
  if (String(pr.number) === q) return 100
  if (title === q) return 90
  if (title.includes(q)) return 80
  if (words.every((w) => title.includes(w))) return 70
  if (pr.headRefName.toLowerCase().includes(q)) return 60
  if (pr.author.login.toLowerCase().includes(q)) return 50
  const hay = `#${pr.number} ${title} ${pr.headRefName} ${pr.author.login}`.toLowerCase()
  if (words.some((w) => hay.includes(w))) return 30
  return 0
}

// ── Detail: the one primary button ───────────────────────────────────────

export type PrimaryControl =
  | 'merged'
  | 'closed'
  | 'resolve'
  | 'ready'
  | 'auto-merge-armed'
  | 'enable-auto-merge'
  | 'merge'
  | null

export function canWrite(repo: Pick<GitHubRepo, 'viewerPermission'>): boolean {
  return ['ADMIN', 'MAINTAIN', 'WRITE'].includes(repo.viewerPermission)
}

/** States GitHub will merge right now; anything else only takes auto-merge. */
export function immediatelyMergeable(mergeStateStatus: string): boolean {
  return ['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(mergeStateStatus)
}

export function primaryControl(pr: PullDetail): PrimaryControl {
  if (pr.state === 'MERGED') return 'merged'
  if (pr.state === 'CLOSED') return 'closed'
  if (pr.mergeable === 'CONFLICTING') return 'resolve'
  const write = canWrite(pr.repo)
  if (pr.state === 'DRAFT') return write || pr.viewerIsAuthor ? 'ready' : null
  if (pr.autoMerge) return 'auto-merge-armed'
  if (!write || pr.repo.mergeMethods.length === 0) return null
  const checks = checksOverall(pr.checks)
  if (checks !== null && checks !== 'passing') return 'enable-auto-merge'
  return 'merge'
}

/** The PR's armed method, then the last one used here, then the repo's default — if the repo allows it. */
export function chooseMergeMethod(pr: Pick<PullDetail, 'autoMerge' | 'repo'>, lastUsed: MergeMethod | null): MergeMethod {
  const allowed = pr.repo.mergeMethods
  for (const m of [pr.autoMerge?.method, lastUsed, pr.repo.defaultMergeMethod]) {
    if (m && allowed.includes(m)) return m
  }
  return allowed[0] ?? 'MERGE'
}

// ── Diff ─────────────────────────────────────────────────────────────────

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffFile {
  path: string
  oldPath?: string
  status: 'added' | 'deleted' | 'renamed' | 'modified'
  binary: boolean
  additions: number
  deletions: number
  lines: DiffLine[]
}

/** `gh pr diff` (a plain unified git diff) → one entry per file with numbered lines. */
export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let oldNo = 0
  let newNo = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      file = { path: m?.[2] ?? line.slice(11), status: 'modified', binary: false, additions: 0, deletions: 0, lines: [] }
      files.push(file)
      continue
    }
    if (!file) continue
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      oldNo = Number(m?.[1] ?? 0)
      newNo = Number(m?.[2] ?? 0)
      file.lines.push({ kind: 'hunk', text: line })
      continue
    }
    if (file.lines.length === 0) {
      // Header lines before the first hunk.
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed'
        file.oldPath = line.slice('rename from '.length)
      } else if (line.startsWith('Binary files ')) file.binary = true
      continue
    }
    if (line.startsWith('+')) {
      file.additions++
      file.lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ })
    } else if (line.startsWith('-')) {
      file.deletions++
      file.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ })
    } else if (line.startsWith('\\')) {
      file.lines.push({ kind: 'meta', text: line })
    } else if (line.startsWith(' ') || line === '') {
      // A trailing '' is the patch's final newline, not a context line.
      if (line === '' && oldNo === 0 && newNo === 0) continue
      file.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  // Drop the phantom context line the patch's trailing newline adds.
  for (const f of files) {
    const last = f.lines[f.lines.length - 1]
    if (last?.kind === 'ctx' && last.text === '') f.lines.pop()
  }
  return files
}

// ── Formatting ───────────────────────────────────────────────────────────

export function relativeTime(iso: string | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.round(mo / 12)}y ago`
}

/** Readable text on a label chip whose background is GitHub's hex colour. */
export function labelTextColor(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  if (!Number.isFinite(n)) return '#fff'
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111' : '#fff'
}
