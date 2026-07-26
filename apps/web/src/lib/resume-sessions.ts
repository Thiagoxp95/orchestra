// Pure helpers for the phone's "Resume a session" sheet: locating each past
// agent session to the workspace tree it ran in, building the scope picker, and
// searching. Kept free of React/Convex imports so they can be unit-tested like
// the rest of src/lib.
//
// The listing itself comes from the desktop on demand (see the agentSessions
// Convex table); this module only shapes what the sheet shows. It mirrors the
// desktop's own resume-session-scopes.ts — same keys, same grouping — so both
// screens narrow the list the same way.

/** One past Claude/Codex conversation, as the desktop mirrors it. */
export interface RemoteAgentSession {
  agent: 'claude' | 'codex'
  sessionId: string
  cwd: string
  cwdExists: boolean
  gitBranch: string | null
  updatedAt: number
  title: string | null
  summary: string | null
  summaryIsUser: boolean
}

export interface ResumeTreeLike {
  rootDir: string
  displayName?: string
  branch?: string
}

export interface ResumeWorkspaceLike {
  id: string
  name: string
  trees: ResumeTreeLike[]
}

export const ALL_SCOPE = '__all__'

export interface SessionScope {
  /** Picker value: `tree:<workspaceId>:<treeIndex>` or `path:<cwd>`. */
  key: string
  workspaceId: string | null
  treeIndex: number | null
  workspaceName: string | null
  treeName: string | null
  /** What the session row shows: `Workspace · tree` (· subdirectory). */
  text: string
}

export interface ScopeOption {
  value: string
  label: string
}

export interface ScopeGroup {
  label: string
  options: ScopeOption[]
}

interface TreeMatch {
  workspaceId: string
  treeIndex: number
  /** False when the session ran in a subdirectory inside the tree, not at its root. */
  exact: boolean
}

function normalizeDir(dir: string): string {
  return dir.replace(/\/+$/, '')
}

function homeRelative(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

function treeLabel(tree: ResumeTreeLike | undefined, treeIndex: number): string {
  if (!tree) return 'worktree'
  if (tree.branch) return tree.branch
  if (treeIndex === 0) return 'base'
  return tree.displayName ?? tree.rootDir.split('/').filter(Boolean).pop() ?? 'worktree'
}

/**
 * The workspace tree that owns a directory. Exact checkout first (the active
 * workspace wins a tie), otherwise the DEEPEST tree containing it — agents are
 * routinely run from a subdirectory, and those sessions belong to that tree.
 * Mirrors the desktop's findTreeForCwd, which is what actually spawns the resume.
 */
export function findTreeForCwd(
  workspaces: ResumeWorkspaceLike[] | undefined,
  cwd: string,
  activeWorkspaceId?: string | null,
): TreeMatch | null {
  const target = normalizeDir(cwd)
  if (!target || !workspaces) return null
  let exactFallback: TreeMatch | null = null
  let nested: TreeMatch | null = null
  let nestedDepth = -1
  for (const workspace of workspaces) {
    for (const [treeIndex, tree] of workspace.trees.entries()) {
      const rootDir = normalizeDir(tree.rootDir)
      if (!rootDir) continue
      if (rootDir === target) {
        if (workspace.id === activeWorkspaceId) return { workspaceId: workspace.id, treeIndex, exact: true }
        exactFallback ??= { workspaceId: workspace.id, treeIndex, exact: true }
      } else if (target.startsWith(`${rootDir}/`) && rootDir.length > nestedDepth) {
        nested = { workspaceId: workspace.id, treeIndex, exact: false }
        nestedDepth = rootDir.length
      }
    }
  }
  return exactFallback ?? nested
}

/** Which workspace tree a session's directory belongs to. */
export function locateSession(
  workspaces: ResumeWorkspaceLike[] | undefined,
  cwd: string,
  activeWorkspaceId?: string | null,
): SessionScope {
  const match = findTreeForCwd(workspaces, cwd, activeWorkspaceId)
  if (!match) {
    return {
      key: `path:${cwd}`,
      workspaceId: null,
      treeIndex: null,
      workspaceName: null,
      treeName: null,
      text: homeRelative(cwd),
    }
  }
  const workspace = workspaces?.find((w) => w.id === match.workspaceId)
  const tree = workspace?.trees[match.treeIndex]
  const workspaceName = workspace?.name ?? '?'
  const treeName = treeLabel(tree, match.treeIndex)
  const inner = match.exact || !tree ? '' : cwd.slice(normalizeDir(tree.rootDir).length + 1)
  return {
    key: `tree:${match.workspaceId}:${match.treeIndex}`,
    workspaceId: match.workspaceId,
    treeIndex: match.treeIndex,
    workspaceName,
    treeName,
    text: inner ? `${workspaceName} · ${treeName} · ${inner}` : `${workspaceName} · ${treeName}`,
  }
}

/** Does a session in `scope` belong to the picked filter value? */
export function matchesScope(picked: string, scope: SessionScope): boolean {
  if (picked === ALL_SCOPE) return true
  if (picked.startsWith('ws:')) return scope.workspaceId === picked.slice(3)
  return scope.key === picked
}

/**
 * The picker's options, grouped by workspace with one entry per worktree that
 * actually has sessions (plus an "everything in here" entry once a workspace has
 * more than one). The active workspace leads; loose directories trail.
 */
export function buildScopeGroups(
  scopes: SessionScope[],
  activeWorkspaceId?: string | null,
): ScopeGroup[] {
  const byWorkspace = new Map<string, { name: string; trees: Map<string, string> }>()
  const loose = new Map<string, string>()
  for (const scope of scopes) {
    if (!scope.workspaceId) {
      if (!loose.has(scope.key)) loose.set(scope.key, scope.text)
      continue
    }
    let entry = byWorkspace.get(scope.workspaceId)
    if (!entry) {
      entry = { name: scope.workspaceName ?? scope.workspaceId, trees: new Map() }
      byWorkspace.set(scope.workspaceId, entry)
    }
    if (!entry.trees.has(scope.key)) entry.trees.set(scope.key, scope.treeName ?? 'worktree')
  }

  const groups: ScopeGroup[] = [...byWorkspace.entries()]
    .sort(([aId, a], [bId, b]) => {
      if (aId === activeWorkspaceId) return -1
      if (bId === activeWorkspaceId) return 1
      return a.name.localeCompare(b.name)
    })
    .map(([workspaceId, entry]) => {
      // Tree keys carry their index, so a numeric sort keeps base first.
      const trees = [...entry.trees.entries()].sort(
        ([a], [b]) => Number(a.split(':')[2]) - Number(b.split(':')[2]),
      )
      const options: ScopeOption[] = trees.map(([value, label]) => ({ value, label }))
      if (options.length > 1) options.unshift({ value: `ws:${workspaceId}`, label: 'All trees' })
      return { label: entry.name, options }
    })

  if (loose.size > 0) {
    groups.push({
      label: 'Other folders',
      options: [...loose.entries()]
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    })
  }
  return groups
}

/** Every option in every group, flattened — for "is the picked value still there?". */
export function flattenScopeGroups(groups: ScopeGroup[]): ScopeOption[] {
  return groups.flatMap((group) => group.options)
}

/**
 * Subsequence match, the same shape of matching a fuzzy file-finder does: the
 * query's characters must appear in order, but not adjacently. Space-separated
 * words are matched independently so "orch web" finds an Orchestra session about
 * the web app regardless of which order those words appear in the text.
 */
export function fuzzyMatch(query: string, text: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = text.toLowerCase()
  return words.every((word) => {
    let at = 0
    for (const char of word) {
      at = haystack.indexOf(char, at)
      if (at === -1) return false
      at++
    }
    return true
  })
}

/** A session paired with where it ran, ready to render. */
export interface LocatedSession {
  session: RemoteAgentSession
  scope: SessionScope
}

export function locateSessions(
  sessions: RemoteAgentSession[] | undefined,
  workspaces: ResumeWorkspaceLike[] | undefined,
  activeWorkspaceId?: string | null,
): LocatedSession[] {
  if (!sessions) return []
  return sessions.map((session) => ({
    session,
    scope: locateSession(workspaces, session.cwd, activeWorkspaceId),
  }))
}

/**
 * The sheet's whole narrowing pipeline: agent, then scope, then free-text search
 * over everything a row shows. Order matters for the pickers above the list —
 * the scope options are built from the agent-filtered set, so switching to Codex
 * drops workspaces that only ever ran Claude.
 */
export function filterSessions(
  located: LocatedSession[],
  { agent, scope, query }: { agent: 'all' | 'claude' | 'codex'; scope: string; query: string },
): LocatedSession[] {
  const byAgent = agent === 'all' ? located : located.filter((l) => l.session.agent === agent)
  const byScope = scope === ALL_SCOPE ? byAgent : byAgent.filter((l) => matchesScope(scope, l.scope))
  const q = query.trim()
  if (!q) return byScope
  return byScope.filter((l) =>
    fuzzyMatch(
      q,
      [l.session.title, l.session.summary, l.session.gitBranch, l.scope.text]
        .filter(Boolean)
        .join(' '),
    ),
  )
}

/**
 * The workspace a resume will land in, so the phone can arm its auto-attach for
 * it. Mirrors the desktop's planResume: the tree that owns the directory, else
 * the desktop's active workspace (which is where it spawns as a fallback).
 */
export function resumeWorkspaceId(
  scope: SessionScope,
  activeWorkspaceId: string | null | undefined,
): string | null {
  return scope.workspaceId ?? activeWorkspaceId ?? null
}
