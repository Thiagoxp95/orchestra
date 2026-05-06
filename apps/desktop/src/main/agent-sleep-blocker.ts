import type { PowerSaveBlocker } from 'electron'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'
import type { ClaudeWorkState, ProcessStatus } from '../shared/types'

export interface AgentSleepBlockerOptions {
  powerSaveBlocker: Pick<PowerSaveBlocker, 'start' | 'stop' | 'isStarted'>
}

type AgentSleepSource = 'normalized' | 'claude-work' | 'cursor-process'

const ACTIVE_NORMALIZED_STATES = new Set([
  'working',
  'waitingApproval',
  'waitingUserInput',
])

export class AgentSleepBlocker {
  private readonly powerSaveBlocker: Pick<PowerSaveBlocker, 'start' | 'stop' | 'isStarted'>
  private readonly activeSourcesBySession = new Map<string, Set<AgentSleepSource>>()
  private blockerId: number | null = null

  constructor(options: AgentSleepBlockerOptions) {
    this.powerSaveBlocker = options.powerSaveBlocker
  }

  updateNormalizedStatus(status: NormalizedAgentSessionStatus): void {
    const active = (
      status.connected
      && ACTIVE_NORMALIZED_STATES.has(status.state)
    )
    this.setSourceActive(status.sessionId, 'normalized', active)
  }

  clearNormalizedStatus(sessionId: string): void {
    this.setSourceActive(sessionId, 'normalized', false)
  }

  updateClaudeWorkState(sessionId: string, state: ClaudeWorkState | null): void {
    this.setSourceActive(sessionId, 'claude-work', state === 'working')
  }

  updateProcessStatus(sessionId: string, status: ProcessStatus): void {
    if (status === 'terminal') {
      this.forgetSession(sessionId)
      return
    }

    this.setSourceActive(sessionId, 'cursor-process', status === 'cursor')
  }

  forgetSession(sessionId: string): void {
    if (!this.activeSourcesBySession.delete(sessionId)) return
    this.syncBlocker()
  }

  stop(): void {
    this.activeSourcesBySession.clear()
    this.syncBlocker()
  }

  private setSourceActive(sessionId: string, source: AgentSleepSource, active: boolean): void {
    const existing = this.activeSourcesBySession.get(sessionId)

    if (active) {
      const sources = existing ?? new Set<AgentSleepSource>()
      sources.add(source)
      this.activeSourcesBySession.set(sessionId, sources)
      this.syncBlocker()
      return
    }

    if (!existing) return
    existing.delete(source)
    if (existing.size === 0) {
      this.activeSourcesBySession.delete(sessionId)
    }
    this.syncBlocker()
  }

  private syncBlocker(): void {
    if (this.activeSourcesBySession.size > 0) {
      if (this.blockerId === null || !this.powerSaveBlocker.isStarted(this.blockerId)) {
        this.blockerId = this.powerSaveBlocker.start('prevent-display-sleep')
      }
      return
    }

    if (this.blockerId === null) return
    const id = this.blockerId
    this.blockerId = null
    if (this.powerSaveBlocker.isStarted(id)) {
      this.powerSaveBlocker.stop(id)
    }
  }
}
