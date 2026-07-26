// Grouping and searching for the "Resume a session" picker.
//
// Every recent agent session is located to the workspace TREE it ran in — the
// worktree, not just the workspace — so the picker can narrow to a single branch
// checkout. Directories that belong to no workspace stay selectable under their
// own path, so nothing on disk is unreachable from the list.

import type { Workspace, WorkspaceTree } from '../../../shared/types'
import { findTreeForCwd } from './resume-agent-session'

export const ALL_SCOPE = '__all__'

export interface SessionScope {
  /** Picker value: `tree:<workspaceId>:<treeIndex>` or `path:<cwd>`. */
  key: string
  workspaceId: string | null
  treeIndex: number | null
  workspaceName: string | null
  /** 'base' for the main checkout, else the worktree's own name. */
  treeName: string | null
  /** What the session row shows: `Workspace · tree` (· subdirectory). */
  text: string
}

export interface ScopeOption {
  value: string
  label: string
}

export interface ScopeGroup {
  /** Workspace name, or the catch-all heading for loose directories. */
  label: string
  options: ScopeOption[]
}

function homeRelative(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

function treeLabel(tree: WorkspaceTree | undefined, treeIndex: number): string {
  if (treeIndex === 0) return 'base'
  return tree?.displayName ?? tree?.rootDir.split('/').filter(Boolean).pop() ?? 'worktree'
}

/**
 * Which workspace tree a session's directory belongs to. Sessions run from a
 * subdirectory keep the subdirectory in their label (`Orchestra · main ·
 * apps/web`) while still grouping under the tree that contains them.
 */
export function locateSession(
  workspaces: Record<string, Workspace>,
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
  const workspace = workspaces[match.workspaceId]
  const tree = workspace?.trees[match.treeIndex]
  const workspaceName = workspace?.name ?? '?'
  const treeName = treeLabel(tree, match.treeIndex)
  const inner = match.exact || !tree ? '' : cwd.slice(tree.rootDir.replace(/\/+$/, '').length + 1)
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
      // Tree keys carry their index, so a numeric sort keeps base first and the
      // worktrees in the order the workspace holds them.
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
