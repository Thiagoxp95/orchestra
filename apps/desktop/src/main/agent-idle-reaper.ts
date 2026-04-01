import type { BrowserWindow } from 'electron'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'

export interface AgentIdleReaperClient {
  suspend(sessionId: string): Promise<void>
}

export interface AgentIdleReaperOptions {
  client: AgentIdleReaperClient
  idleTimeoutMs?: number
  activeSessionRecheckMs?: number
}

interface SessionTimerState {
  timeout: ReturnType<typeof setTimeout>
  delayMs: number
}

export const AGENT_IDLE_REAPER_ENABLE_ENV_VAR = 'ORCHESTRA_ENABLE_AGENT_IDLE_REAPER'
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000
const DEFAULT_ACTIVE_SESSION_RECHECK_MS = 30_000

export function isAgentIdleReaperEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[AGENT_IDLE_REAPER_ENABLE_ENV_VAR]?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

export class AgentIdleReaper {
  private client: AgentIdleReaperClient
  private idleTimeoutMs: number
  private activeSessionRecheckMs: number
  private window: BrowserWindow | null = null
  private activeSessionId: string | null = null
  private statuses = new Map<string, NormalizedAgentSessionStatus>()
  private timers = new Map<string, SessionTimerState>()

  constructor(options: AgentIdleReaperOptions) {
    this.client = options.client
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.activeSessionRecheckMs = options.activeSessionRecheckMs ?? DEFAULT_ACTIVE_SESSION_RECHECK_MS
  }

  init(window: BrowserWindow): void {
    this.window = window
    window.on('focus', () => {
      if (!this.activeSessionId) return
      this.scheduleForSession(this.activeSessionId)
    })
    window.on('blur', () => {
      if (!this.activeSessionId) return
      this.scheduleForSession(this.activeSessionId)
    })
  }

  stop(): void {
    for (const { timeout } of this.timers.values()) {
      clearTimeout(timeout)
    }
    this.timers.clear()
    this.statuses.clear()
    this.window = null
    this.activeSessionId = null
  }

  setActiveSessionId(sessionId: string | null): void {
    const previousActiveSessionId = this.activeSessionId
    this.activeSessionId = sessionId
    if (previousActiveSessionId) {
      this.scheduleForSession(previousActiveSessionId)
    }
    if (sessionId) {
      this.scheduleForSession(sessionId)
    }
  }

  noteActivity(sessionId: string): void {
    const status = this.statuses.get(sessionId)
    if (status && status.state === 'idle') {
      const now = Date.now()
      this.statuses.set(sessionId, {
        ...status,
        lastTransitionAt: now,
        updatedAt: now,
      })
    }
    this.scheduleForSession(sessionId)
  }

  updateStatus(status: NormalizedAgentSessionStatus): void {
    this.statuses.set(status.sessionId, status)

    if (status.state === 'idle') {
      this.scheduleForSession(status.sessionId)
      return
    }

    this.cancel(status.sessionId)
  }

  private scheduleForSession(sessionId: string): void {
    const status = this.statuses.get(sessionId)
    if (!status || status.state !== 'idle') {
      this.cancel(sessionId)
      return
    }

    const idleForMs = Math.max(Date.now() - status.lastTransitionAt, 0)
    const delayMs = this.shouldProtectSession(sessionId)
      ? this.activeSessionRecheckMs
      : Math.max(this.idleTimeoutMs - idleForMs, 0)

    const existing = this.timers.get(sessionId)
    if (existing) {
      clearTimeout(existing.timeout)
    }

    const timeout = setTimeout(() => {
      this.timers.delete(sessionId)
      void this.handleTimer(sessionId)
    }, delayMs)

    this.timers.set(sessionId, { timeout, delayMs })
  }

  private async handleTimer(sessionId: string): Promise<void> {
    const status = this.statuses.get(sessionId)
    if (!status || status.state !== 'idle') return

    if (this.shouldProtectSession(sessionId)) {
      this.scheduleForSession(sessionId)
      return
    }

    try {
      await this.client.suspend(sessionId)
    } catch (error) {
      console.warn('[agent-idle-reaper] failed to suspend session:', sessionId, error)
      this.scheduleForSession(sessionId)
    }
  }

  private cancel(sessionId: string): void {
    const existing = this.timers.get(sessionId)
    if (!existing) return
    clearTimeout(existing.timeout)
    this.timers.delete(sessionId)
  }

  private shouldProtectSession(sessionId: string): boolean {
    return this.activeSessionId === sessionId && this.window?.isFocused() === true
  }
}

export {
  DEFAULT_ACTIVE_SESSION_RECHECK_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
}
