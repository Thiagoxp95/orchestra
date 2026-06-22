import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { Workspace, TerminalSession } from '../shared/types'

export interface SafeTree {
  rootDir: string
  sessionIds: string[]
  displayName?: string
  /** Current git branch of the tree (short sha if detached); undefined if not a repo. */
  branch?: string
}

/** Parse a git `HEAD` file's contents into a branch name, or a short sha if detached. */
export function parseGitHead(headContents: string): string | undefined {
  const line = headContents.trim()
  if (!line) return undefined
  const ref = line.match(/^ref:\s*refs\/heads\/(.+)$/)
  if (ref) return ref[1]
  if (/^[0-9a-f]{40}$/i.test(line)) return line.slice(0, 7) // detached HEAD
  return undefined
}

/**
 * Read a tree's current git branch from the filesystem (no `git` spawn). Handles
 * both a normal repo (`<root>/.git/HEAD`) and a worktree, whose `<root>/.git` is a
 * file `gitdir: <path>` pointing at the real git dir. Returns undefined on any error
 * or non-repo so the mirror degrades gracefully.
 */
export function readTreeBranch(rootDir: string): string | undefined {
  try {
    const dotGit = join(rootDir, '.git')
    let gitDir: string
    if (statSync(dotGit).isDirectory()) {
      gitDir = dotGit
    } else {
      const m = readFileSync(dotGit, 'utf8').trim().match(/^gitdir:\s*(.+)$/)
      if (!m) return undefined
      gitDir = m[1]
    }
    return parseGitHead(readFileSync(join(gitDir, 'HEAD'), 'utf8'))
  } catch {
    return undefined
  }
}

export interface SafeAction {
  id: string
  name: string
  icon: string
}

export interface SafeWorkspace {
  id: string
  name: string
  color: string
  emoji?: string
  trees: SafeTree[]
  activeTreeIndex: number
  customActions: SafeAction[]
}

export interface SafeSession {
  label: string
  processStatus: TerminalSession['processStatus']
  cwd: string
  workspaceId: string
  actionIcon?: string
}

/** Allow-list workspace fields the web needs; never emit secrets (linearConfig, etc). */
export function sanitizeWorkspaces(workspaces: Record<string, Workspace>): SafeWorkspace[] {
  return Object.values(workspaces).map((w) => ({
    id: w.id,
    name: w.name,
    color: w.color,
    emoji: w.emoji,
    trees: w.trees.map((t) => ({
      rootDir: t.rootDir,
      sessionIds: t.sessionIds,
      displayName: t.displayName,
      branch: readTreeBranch(t.rootDir),
    })),
    activeTreeIndex: w.activeTreeIndex,
    // Only id/name/icon — never command, webhookToken, or other sensitive fields.
    customActions: (w.customActions ?? []).map((a) => ({ id: a.id, name: a.name, icon: a.icon })),
  }))
}

export function buildSessionMap(
  sessions: Record<string, TerminalSession>,
): Record<string, SafeSession> {
  const out: Record<string, SafeSession> = {}
  for (const [id, s] of Object.entries(sessions)) {
    out[id] = {
      label: s.label,
      processStatus: s.processStatus,
      cwd: s.cwd,
      workspaceId: s.workspaceId,
      actionIcon: s.actionIcon,
    }
  }
  return out
}
