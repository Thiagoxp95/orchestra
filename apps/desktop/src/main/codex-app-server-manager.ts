import { getCodexAppServer, stopCodexAppServer } from './codex-app-server'
import { mapCodexThreadStatusToState } from './agent-session-authority'
import type { AgentSessionRegistry } from './agent-session-authority'
import type { AgentSessionState } from '../shared/agent-session-types'
import type { CodexThreadStatus } from './codex-thread-state'
import { debugWorkState } from './work-state-debug'

export function mapCodexNotificationToState(
  status: CodexThreadStatus | null | undefined,
): AgentSessionState {
  return mapCodexThreadStatusToState(status)
}

export class CodexAppServerManager {
  private registry: AgentSessionRegistry
  private sessionToThread = new Map<string, string>()
  private threadToSession = new Map<string, string>()
  private notificationCleanup: (() => void) | null = null
  private started = false

  constructor(registry: AgentSessionRegistry) {
    this.registry = registry
  }

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

  /**
   * Start the app-server and listen for notifications.
   * Forces initialization by sending a thread/list request — the underlying
   * CodexAppServerClient starts lazily on first request(), so we must call
   * request() here to actually spawn the process and begin receiving notifications.
   */
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

  /**
   * Create a thread for a new Orchestra Codex session.
   * Returns the threadId or null if creation failed.
   */
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

    // Primary state driver
    if (notification.method === 'thread/status/changed') {
      const status = params.status as CodexThreadStatus | undefined
      const state = mapCodexNotificationToState(status)

      debugWorkState('codex-app-server-state-change', {
        sessionId,
        threadId,
        status,
        state,
      })

      this.registry.transition(sessionId, state, 'codex-app-server')
    }

    // Response preview from item/completed (assistant messages)
    if (notification.method === 'item/completed') {
      const item = params.item as { type?: string; text?: string } | undefined
      if (item?.type === 'agentMessage' && item.text) {
        const preview = item.text.trim().slice(0, 200)
        if (preview) {
          this.registry.updateResponsePreview(sessionId, preview)
        }
      }
    }
  }
}
