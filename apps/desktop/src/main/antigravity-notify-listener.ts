// Localhost HTTP listener that antigravity-notify.sh posts Google Antigravity
// CLI (`agy`) hook events to. Maps them to NormalizedAgentSessionStatus
// (agent: 'antigravity') for the same renderer/notifier plumbing claude, codex,
// and cursor use.
//
// Event → Orchestra state:
//   - SessionStart                         → idle (if no prior state)
//   - PreInvocation                        → working
//   - PreToolUse (ask_question)            → waitingUserInput
//   - PostToolUse                          → working (retires waitingUserInput,
//                                            or recovers working after restart)
//   - Stop                                 → idle (aborted when terminationReason
//                                            is USER_CANCELED)

import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
  AgentSessionState,
  NormalizedAgentSessionStatus,
} from '../shared/agent-session-types'

export type AntigravityHookEvent =
  | 'SessionStart'
  | 'PreInvocation'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'

export interface AntigravityHookBody {
  sessionId: string
  event: AntigravityHookEvent
  /** Stop only: NO_TOOL_CALL | USER_CANCELED | ERROR | MAX_INVOCATIONS | ... */
  terminationReason?: string
  conversationId?: string
  toolName?: string
}

export interface AntigravityStatusMeta {
  /** The turn ended because the user interrupted it (USER_CANCELED). */
  aborted: boolean
}

export interface AntigravityNotifyListenerOptions {
  onStatusUpdate: (status: NormalizedAgentSessionStatus, meta: AntigravityStatusMeta) => void
  onConversationId?: (sessionId: string, conversationId: string) => void
  isKnownSession?: (sessionId: string) => boolean
}

const PARSEABLE_EVENTS: ReadonlySet<string> = new Set([
  'SessionStart',
  'PreInvocation',
  'PreToolUse',
  'PostToolUse',
  'Stop',
])

function isAskQuestionTool(toolName: string | undefined): boolean {
  const normalized = toolName?.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
  return (
    normalized === 'askquestion'
    || normalized === 'askuserquestion'
    || normalized === 'requestuserinput'
  )
}

export function parseAntigravityHookBody(raw: string): AntigravityHookBody | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return null
    const { sessionId, event, terminationReason, conversationId, toolName } = parsed
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    if (typeof event !== 'string' || !PARSEABLE_EVENTS.has(event)) return null
    const body: AntigravityHookBody = { sessionId, event: event as AntigravityHookEvent }
    if (typeof terminationReason === 'string' && terminationReason.length > 0) {
      body.terminationReason = terminationReason
    }
    if (typeof conversationId === 'string' && conversationId.length > 0) {
      body.conversationId = conversationId
    }
    if (typeof toolName === 'string' && toolName.length > 0) {
      body.toolName = toolName
    }
    return body
  } catch {
    return null
  }
}

export class AntigravityNotifyListener {
  private server: http.Server | null = null
  private boundPort: number | null = null
  private readonly opts: AntigravityNotifyListenerOptions
  private readonly latestBySession = new Map<string, NormalizedAgentSessionStatus>()

  constructor(opts: AntigravityNotifyListenerOptions) {
    this.opts = opts
  }

  async start(): Promise<number> {
    if (this.boundPort != null) return this.boundPort

    const server = http.createServer((req, res) => this.handleRequest(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })

    const address = server.address() as AddressInfo | null
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('Failed to determine antigravity notify listener port')
    }

    this.server = server
    this.boundPort = address.port
    return this.boundPort
  }

  getPort(): number | null {
    return this.boundPort
  }

  forgetSession(sessionId: string): void {
    this.latestBySession.delete(sessionId)
  }

  getLatest(sessionId: string): NormalizedAgentSessionStatus | null {
    return this.latestBySession.get(sessionId) ?? null
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.boundPort = null
    this.latestBySession.clear()
  }

  /** Public for testing — apply a parsed event without going through HTTP. */
  ingest(body: AntigravityHookBody, now: number = Date.now()): NormalizedAgentSessionStatus | null {
    if (this.opts.isKnownSession && !this.opts.isKnownSession(body.sessionId)) return null

    if (body.conversationId) {
      this.opts.onConversationId?.(body.sessionId, body.conversationId)
    }

    const previous = this.latestBySession.get(body.sessionId)
    let state: AgentSessionState
    switch (body.event) {
      case 'PreInvocation':
        state = 'working'
        break
      case 'Stop':
        state = 'idle'
        break
      case 'SessionStart':
        // Identity only; never finishes a turn already in flight.
        if (previous) return null
        state = 'idle'
        break
      case 'PreToolUse':
        if (isAskQuestionTool(body.toolName)) {
          state = 'waitingUserInput'
        } else {
          if (previous) return null
          state = 'working'
        }
        break
      case 'PostToolUse':
        // Answering ask_question moves the session back to working; otherwise
        // only restore working if the listener has no record yet (app restart).
        if (previous && previous.state !== 'waitingUserInput') return null
        state = 'working'
        break
    }

    if (previous && previous.state === state) return null

    const next: NormalizedAgentSessionStatus = {
      sessionId: body.sessionId,
      agent: 'antigravity',
      state,
      authority: 'antigravity-hook',
      connected: true,
      lastResponsePreview: previous?.lastResponsePreview ?? '',
      lastTransitionAt: now,
      updatedAt: now,
    }
    this.latestBySession.set(body.sessionId, next)
    this.opts.onStatusUpdate(next, {
      aborted: body.event === 'Stop' && body.terminationReason === 'USER_CANCELED',
    })
    return next
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/antigravity-hook') {
      res.statusCode = 404
      res.end()
      return
    }

    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      raw += chunk
      if (raw.length > 8 * 1024) {
        res.statusCode = 413
        res.end()
        req.destroy()
      }
    })
    req.on('end', () => {
      const body = parseAntigravityHookBody(raw)
      if (!body) {
        res.statusCode = 400
        res.end()
        return
      }
      this.ingest(body)
      res.statusCode = 204
      res.end()
    })
    req.on('error', () => {
      try { res.end() } catch {}
    })
  }
}
