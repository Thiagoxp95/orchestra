// src/main/local-server/github.ts
//
// The web app's GitHub pull-request page, served off the user's own `gh` login.
// Every call names a worktree root the phone can already see in the state
// mirror; that tree's checkout decides the repository, the same way running
// `gh` in a terminal there would. Nothing is cached on disk and no token ever
// leaves this process — `gh` holds the credentials.
//
// Reads are plain calls rather than hub subscriptions: GitHub is the source of
// truth and the page polls it while it is open, so there is nothing for the
// desktop to invalidate.

import { execFile } from 'node:child_process'
import { getRemoteState } from './runtime-state'

const GH_TIMEOUT_MS = 30_000
const GH_MAX_BUFFER = 32 * 1024 * 1024

// ── Shell plumbing ───────────────────────────────────────────────────────

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`
}

/**
 * Run `gh` through the user's login shell so it inherits the PATH a GUI app
 * launched from the Dock lacks (see pr-mirror.ts). Rejects with gh's own stderr,
 * which is what the page shows when an action fails.
 */
export function runGh(cwd: string, args: string[]): Promise<string> {
  const loginShell = process.env.SHELL || '/bin/sh'
  const cmd = ['gh', ...args].map((a, i) => (i === 0 ? a : shellQuote(a))).join(' ')
  return new Promise((resolve, reject) => {
    execFile(
      loginShell,
      ['-l', '-c', cmd],
      { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
      (err, stdout, stderr) => {
        if (err) {
          const message = String(stderr || '').trim().split('\n').filter(Boolean).pop() || err.message
          reject(new Error(message))
          return
        }
        resolve(String(stdout))
      },
    )
  })
}

/**
 * Reads only. GitHub's GraphQL answers a heavy query with a stray 502/504 now
 * and then, so one retry; and a reply that isn't JSON is reported as such
 * rather than as a bare "Unexpected end of JSON input".
 */
async function ghJson<T>(cwd: string, args: string[]): Promise<T> {
  const attempt = async (): Promise<T> => {
    const out = await runGh(cwd, args)
    try {
      return JSON.parse(out) as T
    } catch {
      throw new Error(`GitHub sent an unreadable reply (${out.length} bytes)`)
    }
  }
  return attempt().catch((err: Error) => {
    if (!/HTTP 50[234]|unreadable reply/.test(err.message)) throw err
    return attempt()
  })
}

// ── Scope ────────────────────────────────────────────────────────────────

/**
 * Only directories the desktop already mirrors to the phone may be used as a
 * cwd, so a caller can't point `gh` (and its credentials) at an arbitrary path.
 */
export function assertMirroredRoot(rootDir: unknown): string {
  if (typeof rootDir !== 'string' || !rootDir) throw new Error('rootDir must be a string')
  if (mirroredRoots().includes(rootDir)) return rootDir
  throw new Error('Unknown worktree')
}

function mirroredRoots(): string[] {
  const workspaces = (getRemoteState()?.workspaces ?? []) as { trees?: { rootDir?: string }[] }[]
  return workspaces.flatMap((ws) => (ws.trees ?? []).flatMap((t) => (t.rootDir ? [t.rootDir] : [])))
}

export function parseRepo(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-][\w.-]*\/[\w.-]+$/.test(value)) throw new Error('repo must be owner/name')
  return value
}

/** `owner/name` (lower-cased) from a GitHub remote URL, https or ssh. */
export function remoteRepo(url: string): string | null {
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return m ? m[1].toLowerCase() : null
}

/**
 * The mirrored worktree whose `origin` is `repo`: a PR link tapped in a
 * terminal opens from there, since the session showing it is often in another
 * repository. `prefer` (that session's own tree) wins a tie. Local git only —
 * no GitHub call — and null when no mirrored checkout tracks the repository.
 */
export async function findRepoRoot(repo: string, prefer?: string): Promise<string | null> {
  const want = repo.toLowerCase()
  const roots = mirroredRoots().sort((a, b) => Number(b === prefer) - Number(a === prefer))
  const remotes = await Promise.all(
    roots.map(
      (root) =>
        new Promise<string>((resolve) =>
          execFile('git', ['-C', root, 'remote', 'get-url', 'origin'], { timeout: 5_000 }, (err, out) => resolve(err ? '' : String(out))),
        ),
    ),
  )
  return roots.find((_, i) => remoteRepo(remotes[i]) === want) ?? null
}

export function prNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error('number must be a PR number')
  return value
}

// ── Repository ───────────────────────────────────────────────────────────

export type MergeMethod = 'MERGE' | 'SQUASH' | 'REBASE'

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

const REPO_TTL_MS = 10 * 60_000
const repoCache = new Map<string, { at: number; repo: Promise<GitHubRepo> }>()
let viewerLogin: Promise<string> | null = null

function fetchRepo(cwd: string): Promise<GitHubRepo> {
  viewerLogin ??= runGh(cwd, ['api', 'user', '--jq', '.login'])
    .then((s) => s.trim())
    .catch((err) => {
      viewerLogin = null
      throw err
    })
  return Promise.all([
    ghJson<{
      nameWithOwner: string
      url: string
      defaultBranchRef: { name: string } | null
      viewerPermission: string
      mergeCommitAllowed: boolean
      squashMergeAllowed: boolean
      rebaseMergeAllowed: boolean
      deleteBranchOnMerge: boolean
      viewerDefaultMergeMethod: MergeMethod
    }>(cwd, [
      'repo',
      'view',
      '--json',
      'nameWithOwner,url,defaultBranchRef,viewerPermission,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,deleteBranchOnMerge,viewerDefaultMergeMethod',
    ]),
    viewerLogin,
  ]).then(([r, login]) => {
    const mergeMethods: MergeMethod[] = []
    if (r.squashMergeAllowed) mergeMethods.push('SQUASH')
    if (r.mergeCommitAllowed) mergeMethods.push('MERGE')
    if (r.rebaseMergeAllowed) mergeMethods.push('REBASE')
    return {
      nameWithOwner: r.nameWithOwner,
      url: r.url,
      defaultBranch: r.defaultBranchRef?.name ?? 'main',
      viewerLogin: login,
      viewerPermission: r.viewerPermission,
      mergeMethods,
      defaultMergeMethod: mergeMethods.includes(r.viewerDefaultMergeMethod)
        ? r.viewerDefaultMergeMethod
        : mergeMethods[0] ?? 'MERGE',
      deleteBranchOnMerge: r.deleteBranchOnMerge,
    }
  })
}

export function getRepo(cwd: string): Promise<GitHubRepo> {
  const hit = repoCache.get(cwd)
  if (hit && Date.now() - hit.at < REPO_TTL_MS) return hit.repo
  const repo = fetchRepo(cwd)
  repoCache.set(cwd, { at: Date.now(), repo })
  repo.catch(() => repoCache.delete(cwd))
  return repo
}

// ── Checks ───────────────────────────────────────────────────────────────

export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipped' | 'action'

export interface GitHubCheck {
  name: string
  workflow?: string
  bucket: CheckBucket
  url?: string
  startedAt?: string
  completedAt?: string
}

interface RawCheck {
  __typename: 'CheckRun' | 'StatusContext'
  name?: string
  context?: string
  workflowName?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
  startedAt?: string
  completedAt?: string
}

/** One check run or commit status → the four buckets the page draws. */
export function checkBucket(c: Pick<RawCheck, '__typename' | 'status' | 'conclusion' | 'state'>): CheckBucket {
  if (c.__typename === 'StatusContext') {
    if (c.state === 'SUCCESS') return 'pass'
    if (c.state === 'FAILURE' || c.state === 'ERROR') return 'fail'
    return 'pending'
  }
  if (c.status !== 'COMPLETED') return 'pending'
  switch (c.conclusion) {
    case 'SUCCESS':
      return 'pass'
    case 'NEUTRAL':
    case 'SKIPPED':
      return 'skipped'
    case 'ACTION_REQUIRED':
      return 'action'
    default:
      return 'fail' // FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, STALE
  }
}

function normalizeChecks(raw: RawCheck[] | null | undefined): GitHubCheck[] {
  // A re-run leaves the earlier run in the rollup too; keep the newest per name.
  const byName = new Map<string, GitHubCheck>()
  for (const c of raw ?? []) {
    const name = c.name ?? c.context ?? 'check'
    const key = `${c.workflowName ?? ''}/${name}`
    const check: GitHubCheck = {
      name,
      workflow: c.workflowName || undefined,
      bucket: checkBucket(c),
      url: c.detailsUrl || c.targetUrl || undefined,
      startedAt: c.startedAt?.startsWith('0001') ? undefined : c.startedAt,
      completedAt: c.completedAt?.startsWith('0001') ? undefined : c.completedAt,
    }
    const prev = byName.get(key)
    if (!prev || (check.startedAt ?? '') >= (prev.startedAt ?? '')) byName.set(key, check)
  }
  return [...byName.values()]
}

export interface CheckSummary {
  pass: number
  fail: number
  pending: number
  skipped: number
  action: number
}

export function summarizeChecks(checks: GitHubCheck[]): CheckSummary {
  const s: CheckSummary = { pass: 0, fail: 0, pending: 0, skipped: 0, action: 0 }
  for (const c of checks) s[c.bucket]++
  return s
}

// ── List ─────────────────────────────────────────────────────────────────

export type PullState = 'OPEN' | 'DRAFT' | 'MERGED' | 'CLOSED'

export interface GitHubUser {
  login: string
  name?: string
  avatarUrl: string
  /** A GitHub App (dependabot, …): searched as `author:app/<login>`. */
  isBot?: boolean
}

export interface GitHubLabel {
  name: string
  color: string
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
  reviewDecision: '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string
  labels: GitHubLabel[]
  reviewRequests: string[]
  checks: CheckSummary
  /** True when the viewer is one of the requested reviewers. */
  reviewRequested: boolean
}

const LIST_FIELDS =
  'number,title,state,isDraft,url,author,headRefName,baseRefName,createdAt,updatedAt,additions,deletions,changedFiles,reviewDecision,mergeable,mergeStateStatus,labels,reviewRequests,latestReviews,statusCheckRollup'

interface RawAuthor {
  login: string
  name?: string
  is_bot?: boolean
}

interface RawPull {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  url: string
  author: RawAuthor | null
  headRefName: string
  baseRefName: string
  createdAt: string
  updatedAt: string
  additions: number
  deletions: number
  changedFiles: number
  reviewDecision: PullSummary['reviewDecision']
  mergeable: PullSummary['mergeable']
  mergeStateStatus: string
  labels: { name: string; color: string }[]
  reviewRequests: { login?: string; name?: string; slug?: string }[]
  latestReviews: { author: RawAuthor | null; state: string }[] | null
  statusCheckRollup: RawCheck[] | null
}

/**
 * GitHub leaves reviewDecision empty on repos with no required reviews, so a
 * PR someone approved would still read as unreviewed. Fall back to the latest
 * review from each reviewer, a block winning over an approval (as t3code does).
 */
export function reviewDecisionOf(p: Pick<RawPull, 'reviewDecision' | 'latestReviews'>): PullSummary['reviewDecision'] {
  if (p.reviewDecision === 'APPROVED' || p.reviewDecision === 'CHANGES_REQUESTED') return p.reviewDecision
  const states = (p.latestReviews ?? []).map((r) => r.state)
  if (states.includes('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED'
  if (states.includes('APPROVED')) return 'APPROVED'
  return p.reviewDecision ?? ''
}

function user(a: RawAuthor | null | undefined): GitHubUser {
  const login = a?.login ?? 'ghost'
  // Bots come back as "app/name"; their avatar lives under the bare name.
  const bare = login.replace(/^app\//, '')
  const isBot = a?.is_bot || login.startsWith('app/') || undefined
  return { login: bare, name: a?.name || undefined, avatarUrl: `https://github.com/${bare}.png?size=64`, isBot }
}

function pullState(p: Pick<RawPull, 'state' | 'isDraft'>): PullState {
  return p.state === 'OPEN' && p.isDraft ? 'DRAFT' : p.state
}

function toSummary(p: RawPull, viewer: string): PullSummary {
  const reviewRequests = (p.reviewRequests ?? []).map((r) => r.login ?? r.slug ?? r.name ?? '').filter(Boolean)
  return {
    number: p.number,
    title: p.title,
    state: pullState(p),
    url: p.url,
    author: user(p.author),
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changedFiles,
    reviewDecision: reviewDecisionOf(p),
    mergeable: p.mergeable,
    mergeStateStatus: p.mergeStateStatus,
    labels: p.labels ?? [],
    reviewRequests,
    checks: summarizeChecks(normalizeChecks(p.statusCheckRollup)),
    reviewRequested: reviewRequests.includes(viewer),
  }
}

// The list asks GraphQL directly, the way t3code does: only the overall check
// state per PR instead of `gh pr list`'s every check run, which made a 60-PR
// list ~370 KB and timed GitHub out (504) about one call in three. No
// mergeStateStatus either: GitHub computes it per PR (+2.5 s on 45 PRs), and
// only the detail view's merge button needs it.
const LIST_QUERY = `query($q: String!, $n: Int!) {
  search(query: $q, type: ISSUE, first: $n) {
    nodes {
      ... on PullRequest {
        number title url state isDraft headRefName baseRefName createdAt updatedAt
        additions deletions changedFiles reviewDecision mergeable
        author { __typename login avatarUrl ... on User { name } }
        labels(first: 20) { nodes { name color } }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }
        latestReviews(first: 20) { nodes { state author { login } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`

interface SearchNode {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  headRefName: string
  baseRefName: string
  createdAt: string
  updatedAt: string
  additions: number
  deletions: number
  changedFiles: number
  reviewDecision: PullSummary['reviewDecision'] | null
  mergeable: PullSummary['mergeable']
  author: { __typename?: string; login: string; avatarUrl?: string; name?: string | null } | null
  labels: { nodes: { name: string; color: string }[] }
  reviewRequests: { nodes: { requestedReviewer: { login?: string; slug?: string } | null }[] }
  latestReviews: { nodes: { state: string; author: RawAuthor | null }[] }
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
}

/** The rollup's one overall state, counted as a single check of that bucket. */
export function rollupSummary(state: string | null | undefined): CheckSummary {
  const s: CheckSummary = { pass: 0, fail: 0, pending: 0, skipped: 0, action: 0 }
  if (state === 'SUCCESS') s.pass = 1
  else if (state === 'FAILURE' || state === 'ERROR') s.fail = 1
  else if (state === 'PENDING' || state === 'EXPECTED') s.pending = 1
  return s
}

export function searchNodeToSummary(n: SearchNode, viewer: string): PullSummary {
  const reviewRequests = n.reviewRequests.nodes
    .map((r) => r.requestedReviewer?.login ?? r.requestedReviewer?.slug ?? '')
    .filter(Boolean)
  const author = user(n.author ? { login: n.author.login, name: n.author.name ?? undefined } : null)
  if (n.author?.avatarUrl) author.avatarUrl = n.author.avatarUrl
  if (n.author?.__typename === 'Bot') author.isBot = true
  return {
    number: n.number,
    title: n.title,
    state: pullState(n),
    url: n.url,
    author,
    headRefName: n.headRefName,
    baseRefName: n.baseRefName,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    additions: n.additions,
    deletions: n.deletions,
    changedFiles: n.changedFiles,
    reviewDecision: reviewDecisionOf({ reviewDecision: n.reviewDecision ?? '', latestReviews: n.latestReviews.nodes }),
    mergeable: n.mergeable,
    mergeStateStatus: '',
    labels: n.labels.nodes,
    reviewRequests,
    checks: rollupSummary(n.commits.nodes[0]?.commit.statusCheckRollup?.state),
    reviewRequested: reviewRequests.includes(viewer),
  }
}

const STATE_QUALIFIER: Record<string, string> = {
  open: 'is:open',
  closed: 'is:closed is:unmerged',
  merged: 'is:merged',
  all: '',
}

export type ListStateFilter = 'open' | 'closed' | 'merged' | 'all'

/** Author filter from the page: logins (bots as app/<name>), nothing that could add a qualifier. */
export function parseAuthors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((a): a is string => typeof a === 'string' && /^(app\/)?[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(a)).slice(0, 20)
}
export type Involvement = 'all' | 'authored' | 'reviewing'

export async function listPulls(
  cwd: string,
  opts: { state: ListStateFilter; involvement: Involvement; query?: string; authors?: string[]; limit?: number },
): Promise<{ repo: GitHubRepo; pulls: PullSummary[] }> {
  const repo = await getRepo(cwd)
  const q = [
    `repo:${repo.nameWithOwner}`,
    'is:pr',
    STATE_QUALIFIER[opts.state] ?? 'is:open',
    opts.involvement === 'authored' ? `author:${repo.viewerLogin}` : '',
    opts.involvement === 'reviewing' ? `review-requested:${repo.viewerLogin}` : '',
    // Repeated author: qualifiers are OR'ed by GitHub, so this is "any of these".
    ...(opts.authors ?? []).map((a) => `author:${a}`),
    opts.query?.trim() ?? '',
    'sort:updated-desc',
  ]
    .filter(Boolean)
    .join(' ')
  const raw = await ghJson<{ data?: { search: { nodes: (SearchNode | Record<string, never>)[] } } }>(cwd, [
    'api',
    'graphql',
    '-f',
    `query=${LIST_QUERY}`,
    '-f',
    `q=${q}`,
    '-F',
    `n=${Math.min(opts.limit ?? 60, 100)}`,
  ])
  const nodes = (raw.data?.search.nodes ?? []).filter((n): n is SearchNode => 'number' in n)
  return { repo, pulls: nodes.map((n) => searchNodeToSummary(n, repo.viewerLogin)) }
}

// ── Detail ───────────────────────────────────────────────────────────────

export interface TimelineItem {
  id: string
  kind: 'comment' | 'review' | 'commit' | 'event'
  /** For events: merged, closed, reopened, labeled, review_requested, … */
  event?: string
  actor?: GitHubUser
  createdAt: string
  /** GitHub-rendered, sanitized HTML for comment and review bodies. */
  bodyHtml?: string
  /** APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED for reviews. */
  reviewState?: string
  url?: string
  /** Commit headline and short sha, label name, requested reviewer, … */
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
  /** Head lives in a fork: its branch is not ours to delete. */
  isCrossRepository: boolean
}

interface RawTimelineEvent {
  id?: number | string
  node_id?: string
  event: string
  actor?: { login: string } | null
  user?: { login: string } | null
  author?: { name?: string; date?: string }
  committer?: { date?: string }
  created_at?: string
  submitted_at?: string
  body_html?: string
  state?: string
  html_url?: string
  sha?: string
  message?: string
  label?: { name: string }
  requested_reviewer?: { login: string }
  requested_team?: { name: string }
  commit_id?: string
  rename?: { from: string; to: string }
}

// The events worth a line in the conversation; the rest (subscribed, mentioned,
// referenced by a commit sha, …) are noise GitHub itself hides.
const SHOWN_EVENTS = new Set([
  'merged',
  'closed',
  'reopened',
  'labeled',
  'unlabeled',
  'review_requested',
  'review_request_removed',
  'ready_for_review',
  'convert_to_draft',
  'head_ref_force_pushed',
  'head_ref_deleted',
  'renamed',
  'auto_merge_enabled',
  'auto_merge_disabled',
  'assigned',
])

function loginUser(login: string | undefined): GitHubUser | undefined {
  return login ? user({ login }) : undefined
}

export function toTimeline(raw: RawTimelineEvent[]): TimelineItem[] {
  const out: TimelineItem[] = []
  for (const e of raw) {
    const id = String(e.node_id ?? e.id ?? e.sha ?? `${e.event}-${out.length}`)
    if (e.event === 'commented') {
      out.push({ id, kind: 'comment', actor: loginUser(e.user?.login ?? e.actor?.login), createdAt: e.created_at ?? '', bodyHtml: e.body_html ?? '', url: e.html_url })
    } else if (e.event === 'reviewed') {
      out.push({
        id,
        kind: 'review',
        actor: loginUser(e.user?.login),
        createdAt: e.submitted_at ?? '',
        bodyHtml: e.body_html || undefined,
        reviewState: e.state?.toUpperCase(),
        url: e.html_url,
      })
    } else if (e.event === 'committed') {
      out.push({
        id,
        kind: 'commit',
        createdAt: e.committer?.date ?? e.author?.date ?? '',
        detail: (e.message ?? '').split('\n')[0],
        sha: e.sha,
        url: e.html_url,
        actor: e.author?.name ? { login: e.author.name, avatarUrl: '' } : undefined,
      })
    } else if (SHOWN_EVENTS.has(e.event)) {
      out.push({
        id,
        kind: 'event',
        event: e.event,
        actor: loginUser(e.actor?.login),
        createdAt: e.created_at ?? '',
        detail:
          e.label?.name ??
          e.requested_reviewer?.login ??
          e.requested_team?.name ??
          (e.rename ? `${e.rename.from} → ${e.rename.to}` : undefined) ??
          (e.commit_id ? e.commit_id.slice(0, 7) : undefined),
      })
    }
  }
  return out
}

/** Latest review per reviewer, plus everyone still requested. */
function reviewersOf(
  latestReviews: { author: RawAuthor | null; state: string }[],
  requests: string[],
): PullReviewer[] {
  const out = new Map<string, PullReviewer>()
  for (const r of latestReviews ?? []) {
    const u = user(r.author)
    out.set(u.login, { user: u, state: r.state as PullReviewer['state'] })
  }
  for (const login of requests) {
    if (!out.has(login) || out.get(login)!.state === 'COMMENTED') out.set(login, { user: user({ login }), state: 'REQUESTED' })
  }
  return [...out.values()]
}

const DETAIL_FIELDS = `${LIST_FIELDS},mergedAt,closedAt,mergedBy,commits,assignees,autoMergeRequest,files,isCrossRepository`

export async function getPull(cwd: string, number: number): Promise<PullDetail> {
  const repo = await getRepo(cwd)
  const n = String(number)
  const [raw, bodyHtml, timeline] = await Promise.all([
    ghJson<
      RawPull & {
        mergedAt: string | null
        closedAt: string | null
        mergedBy: RawAuthor | null
        commits: unknown[]
        assignees: RawAuthor[]
        isCrossRepository: boolean
        autoMergeRequest: { mergeMethod: MergeMethod; enabledBy?: { login: string } } | null
        files: { path: string; additions: number; deletions: number }[]
      }
    >(cwd, ['pr', 'view', n, '--json', DETAIL_FIELDS]),
    runGh(cwd, ['api', `repos/${repo.nameWithOwner}/pulls/${n}`, '-H', 'Accept: application/vnd.github.full+json', '--jq', '.body_html // ""']),
    ghJson<RawTimelineEvent[][]>(cwd, [
      'api',
      '--paginate',
      '--slurp',
      `repos/${repo.nameWithOwner}/issues/${n}/timeline?per_page=100`,
      '-H',
      'Accept: application/vnd.github.full+json',
    ]),
  ])
  const summary = toSummary(raw, repo.viewerLogin)
  return {
    ...summary,
    bodyHtml: bodyHtml.trim(),
    mergedAt: raw.mergedAt ?? undefined,
    closedAt: raw.closedAt ?? undefined,
    mergedBy: raw.mergedBy ? user(raw.mergedBy) : undefined,
    commits: raw.commits?.length ?? 0,
    assignees: (raw.assignees ?? []).map(user),
    reviewers: reviewersOf(raw.latestReviews ?? [], summary.reviewRequests),
    checkList: normalizeChecks(raw.statusCheckRollup),
    autoMerge: raw.autoMergeRequest
      ? { method: raw.autoMergeRequest.mergeMethod, enabledBy: raw.autoMergeRequest.enabledBy?.login }
      : undefined,
    files: raw.files ?? [],
    timeline: toTimeline(timeline.flat()),
    repo,
    viewerIsAuthor: summary.author.login === repo.viewerLogin,
    isCrossRepository: raw.isCrossRepository,
  }
}

export function getPullDiff(cwd: string, number: number): Promise<string> {
  return runGh(cwd, ['pr', 'diff', String(number), '--color', 'never'])
}

// ── Actions ──────────────────────────────────────────────────────────────

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

const METHOD_FLAG: Record<MergeMethod, string> = { MERGE: '--merge', SQUASH: '--squash', REBASE: '--rebase' }

export function parseAction(raw: unknown): PullAction {
  const a = (raw ?? {}) as Record<string, unknown>
  const body = typeof a.body === 'string' ? a.body : ''
  switch (a.kind) {
    case 'merge': {
      const method = a.method as MergeMethod
      if (!(method in METHOD_FLAG)) throw new Error('Unknown merge method')
      return { kind: 'merge', method, deleteBranch: a.deleteBranch === true, auto: a.auto === true }
    }
    case 'requestChanges':
    case 'comment':
      if (!body.trim()) throw new Error('A comment is required')
      return { kind: a.kind, body }
    case 'approve':
      return { kind: 'approve', body }
    case 'disableAutoMerge':
    case 'close':
    case 'reopen':
    case 'ready':
    case 'draft':
    case 'updateBranch':
    case 'deleteBranch':
      return { kind: a.kind }
    default:
      throw new Error('Unknown action')
  }
}

/**
 * Apply one action. Merging goes through the REST API rather than
 * `gh pr merge`: in a worktree checked out on the PR's own branch, gh would
 * also try to switch and delete the local branch, which is the agent's
 * working copy. The remote branch is deleted the same way GitHub's button does.
 */
export async function runPullAction(cwd: string, number: number, action: PullAction): Promise<void> {
  const n = String(number)
  switch (action.kind) {
    case 'merge': {
      if (action.auto) {
        await runGh(cwd, ['pr', 'merge', n, '--auto', METHOD_FLAG[action.method]])
        return
      }
      const repo = await getRepo(cwd)
      const head = await ghJson<{ headRefName: string; headRefOid: string; isCrossRepository: boolean }>(cwd, [
        'pr',
        'view',
        n,
        '--json',
        'headRefName,headRefOid,isCrossRepository',
      ])
      await runGh(cwd, [
        'api',
        '-X',
        'PUT',
        `repos/${repo.nameWithOwner}/pulls/${n}/merge`,
        '-f',
        `merge_method=${action.method.toLowerCase()}`,
        '-f',
        `sha=${head.headRefOid}`,
      ])
      if (action.deleteBranch && !head.isCrossRepository) {
        // Already gone is fine: the repo may delete merged branches itself.
        await runGh(cwd, ['api', '-X', 'DELETE', `repos/${repo.nameWithOwner}/git/refs/heads/${head.headRefName}`]).catch(() => {})
      }
      return
    }
    case 'disableAutoMerge':
      await runGh(cwd, ['pr', 'merge', n, '--disable-auto'])
      return
    case 'approve':
      await runGh(cwd, ['pr', 'review', n, '--approve', ...(action.body?.trim() ? ['--body', action.body] : [])])
      return
    case 'requestChanges':
      await runGh(cwd, ['pr', 'review', n, '--request-changes', '--body', action.body])
      return
    case 'comment':
      await runGh(cwd, ['pr', 'comment', n, '--body', action.body])
      return
    case 'close':
      await runGh(cwd, ['pr', 'close', n])
      return
    case 'reopen':
      await runGh(cwd, ['pr', 'reopen', n])
      return
    case 'ready':
      await runGh(cwd, ['pr', 'ready', n])
      return
    case 'draft':
      await runGh(cwd, ['pr', 'ready', n, '--undo'])
      return
    case 'updateBranch':
      await runGh(cwd, ['pr', 'update-branch', n])
      return
    case 'deleteBranch': {
      // Remote only, like GitHub's own button: the local branch may be the
      // checkout an agent is working in.
      const repo = await getRepo(cwd)
      const pr = await ghJson<{ state: string; headRefName: string; baseRefName: string; isCrossRepository: boolean }>(cwd, [
        'pr',
        'view',
        n,
        '--json',
        'state,headRefName,baseRefName,isCrossRepository',
      ])
      if (pr.state === 'OPEN') throw new Error('Close or merge the pull request before deleting its branch')
      if (pr.isCrossRepository) throw new Error('The branch lives in a fork')
      if (pr.headRefName === pr.baseRefName || pr.headRefName === repo.defaultBranch) throw new Error('Refusing to delete the base branch')
      await runGh(cwd, ['api', '-X', 'DELETE', `repos/${repo.nameWithOwner}/git/refs/heads/${pr.headRefName}`])
      return
    }
  }
}

