import type { ClaudeWorkState, CodexWorkState, ProcessStatus } from '../../../shared/types'
import type { NormalizedAgentSessionStatus } from '../../../shared/agent-session-types'

export interface AgentViewInput {
  processStatus: ProcessStatus
  normalizedState?: NormalizedAgentSessionStatus
  claudeWorkState?: ClaudeWorkState
  codexWorkState?: CodexWorkState
  sessionNeedsUserInput: boolean
}

export interface AgentView {
  isAgent: boolean
  isWorking: boolean
  needsInput: boolean
  needsApproval: boolean
  isIdle: boolean
}

const NON_AGENT: AgentView = {
  isAgent: false,
  isWorking: false,
  needsInput: false,
  needsApproval: false,
  isIdle: false,
}

export function computeAgentView(input: AgentViewInput): AgentView {
  const isAgent = input.processStatus === 'claude' || input.processStatus === 'codex'
  if (!isAgent) return NON_AGENT

  const normalized = input.normalizedState?.connected ? input.normalizedState : undefined

  let isWorking = false
  let needsInput = input.sessionNeedsUserInput
  let needsApproval = false

  if (normalized) {
    isWorking = normalized.state === 'working'
    needsInput = needsInput || normalized.state === 'waitingUserInput'
    needsApproval = normalized.state === 'waitingApproval'
  } else if (input.processStatus === 'claude') {
    // Claude's work state arrives via OSC escape sequences, which are authoritative
    // even without normalized state. codexWorkState has no equivalent live signal,
    // so for codex we deliberately do NOT consult codexWorkState here.
    isWorking = input.claudeWorkState === 'working'
  }

  const isIdle = !isWorking && !needsInput && !needsApproval
  return { isAgent: true, isWorking, needsInput, needsApproval, isIdle }
}
