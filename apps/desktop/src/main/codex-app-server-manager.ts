import { getCodexAppServer, stopCodexAppServer } from './codex-app-server'
import type { AgentSessionState } from '../shared/agent-session-types'
import type { CodexThreadStatus } from './codex-thread-state'
import { debugWorkState } from './work-state-debug'

function mapCodexThreadStatusToState(
  status: CodexThreadStatus | null | undefined,
): AgentSessionState {
  if (!status) return 'unknown'

  switch (status.type) {
    case 'idle': return 'idle'
    case 'systemError': return 'error'
    case 'notLoaded': return 'unknown'
    case 'active': {
      const flags = status.activeFlags ?? []
      if (flags.includes('waitingOnUserInput')) return 'waitingUserInput'
      if (flags.includes('waitingOnApproval')) return 'waitingApproval'
      return 'working'
    }
  }
}

export function mapCodexNotificationToState(
  status: CodexThreadStatus | null | undefined,
): AgentSessionState {
  return mapCodexThreadStatusToState(status)
}

export class CodexAppServerManager {
  private sessionToThread = new Map<string, string>()
  private threadToSession = new Map<string, string>()
  private notificationCleanup: (() => void) | null = null
  private started = false

  mapSession(sessionId: string, threadId: string): void {
    this.sessionToThread.set(sessionId, threadId)
    this.threadToSession.set(threadId, sessionId)
  }

  unmapSession(sessionId: string): void {
    const threadId = this.sessionToThread.get(sessionId)
    if (threadId) {
      this.threadToSession.delete(threadId)
    }
    this.sessionToThread.delete(sessionId)
  }

  getThreadIdForSession(sessionId: string): string | undefined {
    return this.sessionToThread.get(sessionId)
  }

  getSessionIdForThread(threadId: string): string | undefined {
    return this.threadToSession.get(threadId)
  }

  async start(): Promise<boolean> {
    if (this.started) return true

    try {
      const client = getCodexAppServer()
      this.notificationCleanup = client.onNotification((notification) => {
        this.handleNotification(notification)
      })
      await client.request('thread/list', {})
      this.started = true
      debugWorkState('codex-app-server-manager-started', {})
      return true
    } catch (error) {
      debugWorkState('codex-app-server-manager-start-failed', {
        error: String(error),
      })
      return false
    }
  }

  async createThread(sessionId: string, cwd: string): Promise<string | null> {
    try {
      const client = getCodexAppServer()
      const result = await client.request<{ threadId: string }>('thread/start', {
        cwd,
      })

      if (result?.threadId) {
        this.mapSession(sessionId, result.threadId)
        debugWorkState('codex-app-server-thread-created', {
          sessionId,
          threadId: result.threadId,
          cwd,
        })
        return result.threadId
      }

      return null
    } catch (error) {
      debugWorkState('codex-app-server-thread-create-failed', {
        sessionId,
        cwd,
        error: String(error),
      })
      return null
    }
  }

  stop(): void {
    this.notificationCleanup?.()
    this.notificationCleanup = null
    this.sessionToThread.clear()
    this.threadToSession.clear()
    this.started = false
    stopCodexAppServer()
  }

  private handleNotification(notification: { method?: string; params?: unknown }): void {
    if (!notification.method) return

    const params = notification.params as Record<string, unknown> | undefined
    if (!params) return

    const threadId = params.threadId as string | undefined
    if (!threadId) return

    const sessionId = this.threadToSession.get(threadId)
    if (!sessionId) return

    if (notification.method === 'thread/status/changed') {
      const status = params.status as CodexThreadStatus | undefined
      const state = mapCodexNotificationToState(status)

      debugWorkState('codex-app-server-state-change', {
        sessionId,
        threadId,
        status,
        state,
      })

    }
  }
}
