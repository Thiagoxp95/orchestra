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
  const isAgent = input.processStatus === 'claude' || input.processStatus === 'codex' || input.processStatus === 'cursor'
  if (!isAgent) return NON_AGENT

  // Only consult normalized state when it was emitted for the agent currently
  // running in this session. The codex hook listener tags every event with
  // agent:'codex'; if Claude in this PTY shells out to `codex` as a tool, those
  // events arrive under the parent Orchestra session id and would otherwise
  // mask the OSC-driven claudeWorkState and freeze the sidebar spinner.
  const normalized = input.normalizedState?.connected
    && input.normalizedState.agent === input.processStatus
    ? input.normalizedState
    : undefined

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
    // Claude TUI's interactive picker (numbered menu) doesn't change the OSC
    // title — it's detected from the picker-footer pattern in PTY output and
    // surfaced as 'waitingUserInput'. Treat it as needs-input even though
    // the OSC title may still indicate working.
    if (input.claudeWorkState === 'waitingUserInput') needsInput = true
  }

  // Working and needs-input are mutually exclusive. If the agent is actively
  // working, suppress the yellow needs-input dot — stale `sessionNeedsUserInput`
  // from a previous idle transition (or a stray OSC notification fired while
  // codex is mid-turn) must not coexist with the loading spinner. The yellow
  // indicator means "idle, waiting on you" by definition, and an agent that's
  // currently working is by definition not idle.
  if (isWorking) {
    needsInput = false
    needsApproval = false
  }

  const isIdle = !isWorking && !needsInput && !needsApproval
  return { isAgent: true, isWorking, needsInput, needsApproval, isIdle }
}
