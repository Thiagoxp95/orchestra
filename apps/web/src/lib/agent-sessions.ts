// Sessions an agent opened through the desktop's MCP server carry origin 'mcp'
// in the mirror. The phone keeps them out of every list and count (drawer,
// roll, overview, workspace badges) unless "Show agent sessions" is on. They stay
// reachable by id: the open session is always listed, and attaching by push tap,
// ?session= link or auto-attach reads the unfiltered mirror.

type OriginLike = { origin?: string } | undefined

interface TreeLike {
  sessionIds: string[]
}

export function isAgentOrigin(session: OriginLike): boolean {
  return session?.origin === 'mcp'
}

/**
 * The workspaces with agent sessions dropped from every tree, unless `show`.
 * `keepId` (the session on screen) always stays. Returns the input unchanged
 * when nothing is hidden, so memoized consumers keep their identity.
 */
export function hideAgentSessions<W extends { trees: TreeLike[] }>(
  workspaces: W[],
  sessions: Record<string, OriginLike>,
  show: boolean,
  keepId: string | null,
): W[] {
  if (show) return workspaces
  const hidden = (sid: string) => sid !== keepId && isAgentOrigin(sessions[sid])
  if (!workspaces.some((ws) => ws.trees.some((t) => t.sessionIds.some(hidden)))) return workspaces
  return workspaces.map((ws) => ({
    ...ws,
    trees: ws.trees.map((t) => ({ ...t, sessionIds: t.sessionIds.filter((sid) => !hidden(sid)) })),
  }))
}

export function countAgentSessions(sessions: Record<string, OriginLike>): number {
  return Object.values(sessions).filter(isAgentOrigin).length
}

// ── The toggle, persisted per device ─────────────────────────────────────────

const STORAGE_KEY = 'orchestra.showAgentSessions'
const listeners = new Set<() => void>()
let memory: boolean | null = null

export function readShowAgentSessions(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function writeShowAgentSessions(show: boolean): void {
  try {
    if (show) localStorage.setItem(STORAGE_KEY, '1')
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Private mode / blocked storage: the toggle still flips for this page.
  }
  memory = show
  for (const fn of listeners) fn()
}

export function getShowAgentSessions(): boolean {
  if (memory === null) memory = readShowAgentSessions()
  return memory
}

export function subscribeShowAgentSessions(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
