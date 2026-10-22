// Workspace-level tally of agent sessions for the sidebar header badge, so a
// collapsed workspace still says what's inside it. Every live agent lands in
// exactly one bucket — working, waiting on you, or idle — so none of them drops
// out of the badge between turns (a finished turn whose ask you've already read
// becomes idle, not invisible). Plain terminals and exited agents never count.

export type AgentKind = 'claude' | 'codex' | 'cursor'

export function asAgentKind(processStatus: string): AgentKind | null {
  return processStatus === 'claude' || processStatus === 'codex' || processStatus === 'cursor'
    ? processStatus
    : null
}

export interface AgentBucket {
  count: number
  /** The first agent found in the bucket, so the badge can wear its logo. */
  agent: AgentKind | null
}

export interface WorkspaceAgentCounts {
  working: AgentBucket
  needsInput: AgentBucket
  idle: AgentBucket
}

interface StatusLike {
  work?: 'idle' | 'working'
  exited?: boolean
  attention?: 'input' | 'approval'
}

export function workspaceAgentCounts(
  ws: { trees: { sessionIds: string[] }[] },
  sessions: Record<string, { processStatus: string } | undefined>,
  liveStatus: Record<string, StatusLike | undefined>,
): WorkspaceAgentCounts {
  const counts: WorkspaceAgentCounts = {
    working: { count: 0, agent: null },
    needsInput: { count: 0, agent: null },
    idle: { count: 0, agent: null },
  }
  for (const tree of ws.trees) {
    for (const sid of tree.sessionIds) {
      const kind = sessions[sid] ? asAgentKind(sessions[sid].processStatus) : null
      if (!kind) continue
      const s = liveStatus[sid]
      if (s?.exited) continue
      // No mirrored status yet still means a live agent pane — call it idle
      // rather than leave it out.
      const bucket = s?.attention ? counts.needsInput : s?.work === 'working' ? counts.working : counts.idle
      bucket.count++
      bucket.agent ??= kind
    }
  }
  return counts
}
