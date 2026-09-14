// Localhost HTTP listener that cursor-notify.sh posts Cursor CLI hook events to.
// Maps them to NormalizedAgentSessionStatus (agent: 'cursor') for the same
// renderer/notifier plumbing claude and codex use.
//
// Cursor's TUI sets no spinner title and writes no JSONL transcript, so unlike
// claude (OSC fallback) and codex (rollout watcher) the hook stream is the only
// live signal. Measured against cursor 2026.09.10:
//   - beforeSubmitPrompt fires on every interactive prompt → working
//   - stop fires at the end of every turn, including an interrupt (status
//     `aborted`) and a failed turn (status `error`) → idle
//   - sessionStart fires at launch, before any prompt → idle
//
// Cursor runs hooks concurrently rather than awaiting each one, so a tool event
// can land AFTER the turn's stop. Tool events therefore never overturn a known
// state; they only restore 'working' for a pane the listener has no record of
// (the app restarted mid-turn).

import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
  AgentSessionState,
  NormalizedAgentSessionStatus,
} from '../shared/agent-session-types'

export type CursorHookEvent = 'sessionStart' | 'beforeSubmitPrompt' | 'preToolUse' | 'postToolUse' | 'stop'

export interface CursorHookBody {
  sessionId: string
  event: CursorHookEvent
  /** stop only: completed | aborted | error. */
  status?: string
  conversationId?: string
}

export interface CursorStatusMeta {
  /** The turn ended because the user interrupted it. */
  aborted: boolean
}

export interface CursorNotifyListenerOptions {
  onStatusUpdate: (status: NormalizedAgentSessionStatus, meta: CursorStatusMeta) => void
  isKnownSession?: (sessionId: string) => boolean
}

const PARSEABLE_EVENTS: ReadonlySet<string> = new Set([
  'sessionStart',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'stop',
])

export function parseCursorHookBody(raw: string): CursorHookBody | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return null
    const { sessionId, event, status, conversationId } = parsed
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    if (typeof event !== 'string' || !PARSEABLE_EVENTS.has(event)) return null
    const body: CursorHookBody = { sessionId, event: event as CursorHookEvent }
    if (typeof status === 'string' && status.length > 0) body.status = status
    if (typeof conversationId === 'string' && conversationId.length > 0) body.conversationId = conversationId
    return body
  } catch {
    return null
  }
}

export class CursorNotifyListener {
  private server: http.Server | null = null
  private boundPort: number | null = null
  private readonly opts: CursorNotifyListenerOptions
  private readonly latestBySession = new Map<string, NormalizedAgentSessionStatus>()

  constructor(opts: CursorNotifyListenerOptions) {
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
      throw new Error('Failed to determine cursor notify listener port')
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
  ingest(body: CursorHookBody, now: number = Date.now()): NormalizedAgentSessionStatus | null {
    if (this.opts.isKnownSession && !this.opts.isKnownSession(body.sessionId)) return null

    const previous = this.latestBySession.get(body.sessionId)
    let state: AgentSessionState
    switch (body.event) {
      case 'beforeSubmitPrompt':
        state = 'working'
        break
      case 'stop':
        state = 'idle'
        break
      case 'sessionStart':
        // Identity only; never finishes a turn already in flight.
        if (previous) return null
        state = 'idle'
        break
      case 'preToolUse':
      case 'postToolUse':
        if (previous) return null
        state = 'working'
        break
    }

    if (previous && previous.state === state) return null

    const next: NormalizedAgentSessionStatus = {
      sessionId: body.sessionId,
      agent: 'cursor',
      state,
      authority: 'cursor-hook',
      connected: true,
      lastResponsePreview: previous?.lastResponsePreview ?? '',
      lastTransitionAt: now,
      updatedAt: now,
    }
    this.latestBySession.set(body.sessionId, next)
    this.opts.onStatusUpdate(next, { aborted: body.event === 'stop' && body.status === 'aborted' })
    return next
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/cursor-hook') {
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
      const body = parseCursorHookBody(raw)
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
