import { getCodexAppServer, stopCodexAppServer } from './codex-app-server'
import type { AgentSessionState, NormalizedAgentSessionStatus } from '../shared/agent-session-types'
import type { CodexThreadDetail, CodexThreadStatus } from './codex-thread-state'
import { extractLastCodexResponse, getCodexWorkStateFromThread } from './codex-thread-state'
import { debugWorkState } from './work-state-debug'

interface CodexAppServerLike {
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  getRemoteUrl?(): string | null
  onNotification?(listener: (notification: { method?: string; params?: unknown }) => void): () => void
  onServerRequest?(listener: (request: { id?: number | string; method?: string; params?: unknown }) => void): () => void
  stop?(): void
}

interface CodexThreadEnvelope extends CodexThreadDetail {
  id: string
}

interface CodexThreadStartResponse {
  thread?: CodexThreadEnvelope
  threadId?: string
}

interface CodexThreadReadResponse {
  thread: CodexThreadEnvelope
}

export interface CodexAppServerManagerOptions {
  onStatusUpdate?: (status: NormalizedAgentSessionStatus) => void
  client?: CodexAppServerLike
  pollIntervalMs?: number
}

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

function mapCodexThreadToState(
  thread: CodexThreadDetail | null | undefined,
): AgentSessionState {
  const status = thread?.status
  if (status?.type === 'systemError') return 'error'
  if (status?.type === 'notLoaded') return 'unknown'

  const workState = getCodexWorkStateFromThread(thread)
  switch (workState) {
    case 'working':
      return 'working'
    case 'waitingApproval':
      return 'waitingApproval'
    case 'waitingUserInput':
      return 'waitingUserInput'
    case 'idle':
      return 'idle'
  }
}

export class CodexAppServerManager {
  private readonly client: CodexAppServerLike
  private readonly pollIntervalMs: number
  private readonly onStatusUpdate?: (status: NormalizedAgentSessionStatus) => void
  private readonly sessionToThread = new Map<string, string>()
  private readonly threadToSession = new Map<string, string>()
  private readonly latestStatusBySession = new Map<string, NormalizedAgentSessionStatus>()
  private notificationCleanup: (() => void) | null = null
  private serverRequestCleanup: (() => void) | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private pollInFlight = false
  private started = false

  constructor(opts: CodexAppServerManagerOptions = {}) {
    this.client = opts.client ?? getCodexAppServer()
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000
    this.onStatusUpdate = opts.onStatusUpdate
  }

  mapSession(sessionId: string, threadId: string): void {
    const previousThreadId = this.sessionToThread.get(sessionId)
    if (previousThreadId && previousThreadId !== threadId) {
      this.threadToSession.delete(previousThreadId)
    }

    this.sessionToThread.set(sessionId, threadId)
    this.threadToSession.set(threadId, sessionId)
    this.ensurePolling()
  }

  async unmapSession(sessionId: string): Promise<void> {
    const threadId = this.sessionToThread.get(sessionId)
    if (threadId) {
      this.threadToSession.delete(threadId)
      try {
        await this.client.request('thread/unsubscribe', { threadId })
      } catch {}
    }

    this.sessionToThread.delete(sessionId)
    this.latestStatusBySession.delete(sessionId)
    this.stopPollingIfIdle()
  }

  getThreadIdForSession(sessionId: string): string | undefined {
    return this.sessionToThread.get(sessionId)
  }

  getSessionIdForThread(threadId: string): string | undefined {
    return this.threadToSession.get(threadId)
  }

  getRemoteUrl(): string | null {
    return this.client.getRemoteUrl?.() ?? null
  }

  isSessionAuthoritative(sessionId: string): boolean {
    const status = this.latestStatusBySession.get(sessionId)
    if (!status) return false
    return status.authority === 'codex-app-server' && status.connected
  }

  async start(): Promise<boolean> {
    if (this.started) return true

    try {
      if (this.client.onNotification) {
        this.notificationCleanup = this.client.onNotification((notification) => {
          this.handleNotification(notification)
        })
      }
      if (this.client.onServerRequest) {
        this.serverRequestCleanup = this.client.onServerRequest((request) => {
          this.handleServerRequest(request)
        })
      }

      await this.client.request('thread/list', {})
      this.started = true
      this.ensurePolling()

      debugWorkState('codex-app-server-manager-started', {
        remoteUrl: this.getRemoteUrl(),
      })
      return true
    } catch (error) {
      debugWorkState('codex-app-server-manager-start-failed', {
        error: String(error),
      })
      return false
    }
  }

  async createThread(sessionId: string, cwd: string): Promise<string | null> {
    if (!(await this.start())) return null

    try {
      const result = await this.client.request<CodexThreadStartResponse>('thread/start', {
        cwd,
      })

      const threadId = result?.thread?.id ?? result?.threadId
      if (!threadId) return null

      this.mapSession(sessionId, threadId)

      if (result.thread) {
        this.applyThreadSnapshot(sessionId, result.thread)
      }

      try {
        await this.client.request('thread/unsubscribe', { threadId })
      } catch {}

      void this.refreshSession(sessionId)

      debugWorkState('codex-app-server-thread-created', {
        sessionId,
        threadId,
        cwd,
        remoteUrl: this.getRemoteUrl(),
      })
      return threadId
    } catch (error) {
      debugWorkState('codex-app-server-thread-create-failed', {
        sessionId,
        cwd,
        error: String(error),
      })
      return null
    }
  }

  async refreshSession(sessionId: string): Promise<void> {
    const threadId = this.sessionToThread.get(sessionId)
    if (!threadId) return

    try {
      const response = await this.client.request<CodexThreadReadResponse>('thread/read', {
        threadId,
        includeTurns: true,
      })
      this.applyThreadSnapshot(sessionId, response.thread)
    } catch (error) {
      this.emitDisconnectedStatus(sessionId, String(error))
    }
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.notificationCleanup?.()
    this.notificationCleanup = null
    this.serverRequestCleanup?.()
    this.serverRequestCleanup = null
    this.sessionToThread.clear()
    this.threadToSession.clear()
    this.latestStatusBySession.clear()
    this.pollInFlight = false
    this.started = false
    this.client.stop?.()
    stopCodexAppServer()
  }

  private ensurePolling(): void {
    if (this.pollTimer || this.sessionToThread.size === 0) return
    this.pollTimer = setInterval(() => {
      void this.pollOnce()
    }, this.pollIntervalMs)
  }

  private stopPollingIfIdle(): void {
    if (this.sessionToThread.size > 0) return
    if (!this.pollTimer) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private async pollOnce(): Promise<void> {
    if (this.pollInFlight || this.sessionToThread.size === 0) return
    this.pollInFlight = true

    try {
      const sessions = Array.from(this.sessionToThread.keys())
      await Promise.all(sessions.map(async (sessionId) => {
        await this.refreshSession(sessionId)
      }))
    } finally {
      this.pollInFlight = false
    }
  }

  private applyThreadSnapshot(sessionId: string, thread: CodexThreadDetail): void {
    const previous = this.latestStatusBySession.get(sessionId)
    const state = mapCodexThreadToState(thread)
    const lastResponsePreview = extractLastCodexResponse(thread) || previous?.lastResponsePreview || ''
    const now = Date.now()

    const next: NormalizedAgentSessionStatus = {
      sessionId,
      agent: 'codex',
      state,
      authority: 'codex-app-server',
      connected: true,
      lastResponsePreview,
      lastTransitionAt: previous?.state === state ? previous.lastTransitionAt : now,
      updatedAt: now,
    }

    if (!previous && state === 'idle' && !lastResponsePreview) {
      this.latestStatusBySession.set(sessionId, next)
      return
    }

    if (this.isSameStatus(previous, next)) return
    this.latestStatusBySession.set(sessionId, next)
    this.onStatusUpdate?.(next)
  }

  private emitDisconnectedStatus(sessionId: string, degradedReason: string): void {
    const previous = this.latestStatusBySession.get(sessionId)
    if (!previous) return

    const next: NormalizedAgentSessionStatus = {
      ...previous,
      connected: false,
      degradedReason,
      updatedAt: Date.now(),
    }

    if (this.isSameStatus(previous, next)) return
    this.latestStatusBySession.set(sessionId, next)
    this.onStatusUpdate?.(next)
  }

  private isSameStatus(
    previous: NormalizedAgentSessionStatus | undefined,
    next: NormalizedAgentSessionStatus,
  ): boolean {
    if (!previous) return false
    return (
      previous.state === next.state
      && previous.connected === next.connected
      && previous.degradedReason === next.degradedReason
      && previous.lastResponsePreview === next.lastResponsePreview
    )
  }

  private handleNotification(notification: { method?: string; params?: unknown }): void {
    if (!notification.method) return

    const params = notification.params as Record<string, unknown> | undefined
    const threadId = typeof params?.threadId === 'string' ? params.threadId : null
    const sessionId = threadId ? this.threadToSession.get(threadId) : undefined

    if (notification.method === 'thread/status/changed' && threadId && sessionId) {
      const status = params?.status as CodexThreadStatus | undefined
      const previous = this.latestStatusBySession.get(sessionId)
      const now = Date.now()
      const next: NormalizedAgentSessionStatus = {
        sessionId,
        agent: 'codex',
        state: mapCodexNotificationToState(status),
        authority: 'codex-app-server',
        connected: true,
        lastResponsePreview: previous?.lastResponsePreview ?? '',
        lastTransitionAt: previous?.state === mapCodexNotificationToState(status) ? previous.lastTransitionAt : now,
        updatedAt: now,
      }

      if (!this.isSameStatus(previous, next)) {
        this.latestStatusBySession.set(sessionId, next)
        this.onStatusUpdate?.(next)
      }
      return
    }

    if (notification.method === 'turn/completed' && threadId && sessionId) {
      void this.refreshSession(sessionId)
    }
  }

  private handleServerRequest(request: { id?: number | string; method?: string; params?: unknown }): void {
    if (!request.method) return

    const params = request.params as Record<string, unknown> | undefined
    const threadId = typeof params?.threadId === 'string' ? params.threadId : null
    const sessionId = threadId ? this.threadToSession.get(threadId) : undefined
    if (!threadId || !sessionId) return

    let state: AgentSessionState | null = null
    if (request.method === 'item/tool/requestUserInput') {
      state = 'waitingUserInput'
    } else if (
      request.method === 'item/commandExecution/requestApproval'
      || request.method === 'item/fileChange/requestApproval'
      || request.method === 'item/permissions/requestApproval'
    ) {
      state = 'waitingApproval'
    }

    if (!state) return

    const previous = this.latestStatusBySession.get(sessionId)
    const now = Date.now()
    const next: NormalizedAgentSessionStatus = {
      sessionId,
      agent: 'codex',
      state,
      authority: 'codex-app-server',
      connected: true,
      lastResponsePreview: previous?.lastResponsePreview ?? '',
      lastTransitionAt: previous?.state === state ? previous.lastTransitionAt : now,
      updatedAt: now,
    }

    if (this.isSameStatus(previous, next)) return
    this.latestStatusBySession.set(sessionId, next)
    this.onStatusUpdate?.(next)
  }
}
