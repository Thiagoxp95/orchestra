export type CodexWorkState = 'idle' | 'working'

export interface CodexThreadStatus {
  type: 'active' | 'idle' | 'notLoaded' | 'systemError'
  activeFlags?: string[]
}

export interface CodexThreadSummary {
  id: string
  createdAt: number
  updatedAt: number
  status: CodexThreadStatus
}

export const CODEX_THREAD_ASSIGNMENT_GRACE_MS = 30_000

export interface CodexThreadDetail {
  status?: CodexThreadStatus
  turns?: Array<{
    status?: 'completed' | 'interrupted' | 'failed' | 'inProgress'
    items?: Array<{
      type?: string
      text?: string
      phase?: 'commentary' | 'final_answer' | string | null
    }>
  }>
}

export function getCodexWorkState(status: CodexThreadStatus | null | undefined): CodexWorkState {
  if (!status || status.type !== 'active') return 'idle'

  const activeFlags = status.activeFlags ?? []
  if (activeFlags.includes('waitingOnApproval') || activeFlags.includes('waitingOnUserInput')) {
    return 'idle'
  }

  return 'working'
}

export function getCodexWorkStateFromThread(thread: CodexThreadDetail | null | undefined): CodexWorkState {
  const latestTurn = getLatestCodexTurn(thread)
  if (latestTurn?.status === 'inProgress') {
    const activeFlags = thread?.status?.type === 'active' ? thread.status.activeFlags ?? [] : []
    if (activeFlags.includes('waitingOnApproval') || activeFlags.includes('waitingOnUserInput')) {
      return 'idle'
    }

    return 'working'
  }

  if (
    latestTurn?.status === 'completed'
    || latestTurn?.status === 'interrupted'
    || latestTurn?.status === 'failed'
  ) {
    return 'idle'
  }

  return getCodexWorkState(thread?.status)
}

export function extractLastCodexResponse(thread: CodexThreadDetail | null | undefined): string {
  const turns = thread?.turns ?? []
  let fallback = ''

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const items = turns[turnIndex]?.items ?? []
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
      const item = items[itemIndex]
      if (item?.type !== 'agentMessage') continue
      const text = item.text?.trim()
      if (!text) continue
      if (item.phase === 'final_answer') return text
      if (!fallback) fallback = text
    }
  }

  return fallback
}

export function wasCodexThreadUpdatedForProcess(
  thread: CodexThreadSummary | null | undefined,
  processStartedAtMs: number,
  graceMs = CODEX_THREAD_ASSIGNMENT_GRACE_MS
): boolean {
  if (!thread) return false
  return thread.updatedAt * 1000 >= processStartedAtMs - graceMs
}

function getLatestCodexTurn(thread: CodexThreadDetail | null | undefined) {
  const turns = thread?.turns ?? []
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const turn = turns[turnIndex]
    if (turn) return turn
  }

  return null
}

export function rankCodexThreads(
  threads: CodexThreadSummary[],
  watchedAtMs: number,
  loadedThreadIds: ReadonlySet<string>
): CodexThreadSummary[] {
  return [...threads].sort((left, right) => {
    const leftLoaded = loadedThreadIds.has(left.id) ? 0 : 1
    const rightLoaded = loadedThreadIds.has(right.id) ? 0 : 1
    if (leftLoaded !== rightLoaded) return leftLoaded - rightLoaded

    const leftDistance = Math.abs(left.createdAt * 1000 - watchedAtMs)
    const rightDistance = Math.abs(right.createdAt * 1000 - watchedAtMs)
    if (leftDistance !== rightDistance) return leftDistance - rightDistance

    return right.updatedAt - left.updatedAt
  })
}

export function pickAssignableCodexThreadId(
  threads: CodexThreadSummary[],
  watchedAtMs: number,
  loadedThreadIds: ReadonlySet<string>,
  assignments: ReadonlyMap<string, string>,
  sessionId: string
): string | null {
  for (const thread of rankCodexThreads(threads, watchedAtMs, loadedThreadIds)) {
    const owner = assignments.get(thread.id)
    if (!owner || owner === sessionId) {
      return thread.id
    }
  }

  return null
}
