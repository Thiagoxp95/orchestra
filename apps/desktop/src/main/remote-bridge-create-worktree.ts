// Pure normalizer for the web→desktop `createWorktree` command payload. Kept in
// its own module (free of Electron imports) so it is unit-testable, mirroring
// the other remote-bridge helpers (sanitize/batcher/settle).

export type SpinUpAgent = 'terminal' | 'claude' | 'codex' | 'cursor'

const SPIN_UP_AGENTS: SpinUpAgent[] = ['terminal', 'claude', 'codex', 'cursor']

export interface CreateWorktreePayload {
  workspaceId: string
  branch: string
  selectedActionIds: string[]
  spinUp: SpinUpAgent | null
}

export function normalizeCreateWorktreePayload(payload: unknown): CreateWorktreePayload {
  const p = (payload ?? {}) as Record<string, unknown>
  const spinUpRaw = p.spinUp
  const spinUp = SPIN_UP_AGENTS.includes(spinUpRaw as SpinUpAgent) ? (spinUpRaw as SpinUpAgent) : null
  return {
    workspaceId: String(p.workspaceId ?? ''),
    branch: String(p.branch ?? ''),
    selectedActionIds: Array.isArray(p.selectedActionIds) ? p.selectedActionIds.map((x) => String(x)) : [],
    spinUp,
  }
}
