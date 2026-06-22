// Pure normalizer for the web→desktop `spawnInTree` command payload — open a
// terminal/agent or run a custom action in a specific workspace tree (worktree).
// Kept free of Electron imports so it is unit-testable, like the other bridge helpers.

export type SpinUpAgent = 'terminal' | 'claude' | 'codex' | 'cursor'

const SPIN_UP_AGENTS: SpinUpAgent[] = ['terminal', 'claude', 'codex', 'cursor']

export interface SpawnInTreePayload {
  workspaceId: string
  treeIndex: number
  /** Spin up this agent (terminal/claude/codex/cursor), or null when running an action. */
  agent: SpinUpAgent | null
  /** Run this custom action in the tree, or null when spinning up an agent. */
  actionId: string | null
}

export function normalizeSpawnInTreePayload(payload: unknown): SpawnInTreePayload {
  const p = (payload ?? {}) as Record<string, unknown>
  const agentRaw = p.agent
  const agent = SPIN_UP_AGENTS.includes(agentRaw as SpinUpAgent) ? (agentRaw as SpinUpAgent) : null
  const idx = Number(p.treeIndex)
  return {
    workspaceId: String(p.workspaceId ?? ''),
    treeIndex: Number.isInteger(idx) && idx >= 0 ? idx : 0,
    agent,
    actionId: typeof p.actionId === 'string' ? p.actionId : null,
  }
}
