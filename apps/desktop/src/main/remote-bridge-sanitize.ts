import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { Workspace, TerminalSession } from '../shared/types'
import type { LinearIssueDetail } from '../shared/linear-types'
import { workspaceDisplayEmoji } from '../shared/workspace-emoji'

export interface SafeTree {
  rootDir: string
  sessionIds: string[]
  displayName?: string
  /** Current git branch of the tree (short sha if detached); undefined if not a repo. */
  branch?: string
  /** Linked Linear ticket resolved from the branch identifier; undefined if none/unresolved. */
  linearIssue?: LinearIssueDetail
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
  /**
   * Always populated: a workspace with no emoji of its own gets the same
   * position-derived stand-in the desktop sidebar draws, so the phone never
   * renders a naked row where the desktop shows an icon.
   */
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
  /**
   * Current desktop PTY geometry, merged in by the bridge from live resize taps.
   * The phone is a viewer: it adopts this geometry for its own xterm (rather than
   * imposing its size on the shared PTY, which would fight the desktop's reflow),
   * then scales the font to fit. Absent until the desktop has reported a size.
   */
  cols?: number
  rows?: number
}

/**
 * Allow-list workspace fields the web needs; never emit secrets (linearConfig, etc).
 * `resolveLinearIssue` maps a tree's branch to its already-resolved Linear ticket
 * detail (from the main-side cache) — omitted in tests, so trees carry no ticket.
 *
 * Emitted in the desktop sidebar's own order (oldest workspace first), because the
 * fallback emoji is derived from that position — mirror them in map order and a
 * workspace can wear a different icon on the phone than it does on the desktop.
 */
export function sanitizeWorkspaces(
  workspaces: Record<string, Workspace>,
  resolveLinearIssue?: (branch: string | undefined) => LinearIssueDetail | undefined,
): SafeWorkspace[] {
  const ordered = Object.values(workspaces).sort((a, b) => a.createdAt - b.createdAt)
  return ordered.map((w, idx) => ({
    id: w.id,
    name: w.name,
    color: w.color,
    emoji: workspaceDisplayEmoji(w.emoji, idx),
    trees: w.trees.map((t) => {
      const branch = readTreeBranch(t.rootDir)
      return {
        rootDir: t.rootDir,
        sessionIds: t.sessionIds,
        displayName: t.displayName,
        branch,
        linearIssue: resolveLinearIssue?.(branch),
      }
    }),
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
