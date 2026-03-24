import { useCallback, useMemo } from 'react'
import { useAppStore } from '../store/app-store'
import type { AgentSessionState, NormalizedAgentSessionStatus } from '../../../shared/agent-session-types'

function deriveLegacyState(
  processStatus: 'claude' | 'codex',
  claudeWorkState: string | undefined,
  codexWorkState: string | undefined,
  needsInput: boolean | undefined,
): AgentSessionState {
  if (processStatus === 'claude') {
    return claudeWorkState === 'working' ? 'working' : 'idle'
  }

  if (codexWorkState === 'waitingUserInput' || needsInput) return 'waitingUserInput'
  if (codexWorkState === 'waitingApproval') return 'waitingApproval'
  if (codexWorkState === 'working') return 'working'
  return 'idle'
}

export function useNormalizedAgentState(
  sessionId: string,
  processStatus: 'terminal' | 'claude' | 'codex',
): NormalizedAgentSessionStatus | null {
  const normalized = useAppStore(
    useCallback((s) => s.normalizedAgentState[sessionId] ?? null, [sessionId])
  )

  const legacyState = useAppStore(
    useCallback((s) => {
      if (processStatus === 'terminal') return null
      return deriveLegacyState(
        processStatus,
        s.claudeWorkState[sessionId],
        s.codexWorkState[sessionId],
        s.sessionNeedsUserInput[sessionId],
      )
    }, [sessionId, processStatus])
  )

  const fallback = useMemo(() => {
    if (normalized || !legacyState || processStatus === 'terminal') return null
    return {
      sessionId,
      agent: processStatus as 'claude' | 'codex',
      state: legacyState,
      authority: (processStatus === 'claude' ? 'claude-watcher-fallback' : 'codex-watcher-fallback') as const,
      connected: true,
      lastResponsePreview: '',
      lastTransitionAt: 0,
      updatedAt: 0,
    } satisfies NormalizedAgentSessionStatus
  }, [normalized, legacyState, sessionId, processStatus])

  return normalized ?? fallback
}
