import type { Workspace, TerminalSession } from '../shared/types'

export interface SafeTree {
  rootDir: string
  sessionIds: string[]
  displayName?: string
}

export interface SafeWorkspace {
  id: string
  name: string
  color: string
  emoji?: string
  trees: SafeTree[]
  activeTreeIndex: number
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
    })),
    activeTreeIndex: w.activeTreeIndex,
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
