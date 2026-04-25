// Tiny localhost HTTP listener that the codex-notify hook posts events to.
// Maps codex hook event names to NormalizedAgentSessionStatus and hands them
// off to the supplied callback so the rest of the app can stay agnostic.
//
// The listener binds to 127.0.0.1 on an OS-assigned port; the port is exported
// so it can be injected into each codex PTY as ORCHESTRA_CODEX_HOOK_PORT.

import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
  AgentSessionState,
  NormalizedAgentSessionStatus,
} from '../shared/agent-session-types'

export type CodexHookEvent = 'SessionStart' | 'UserPromptSubmit' | 'Stop'

interface CodexHookBody {
  sessionId: string
  event: CodexHookEvent
}

export interface CodexNotifyListenerOptions {
  onStatusUpdate: (status: NormalizedAgentSessionStatus) => void
  /** Optional check so we ignore POSTs for sessions that no longer exist. */
  isKnownSession?: (sessionId: string) => boolean
}

const PARSEABLE_EVENTS: ReadonlySet<CodexHookEvent> = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
])

function eventToState(event: CodexHookEvent): AgentSessionState | null {
  switch (event) {
    case 'UserPromptSubmit': return 'working'
    case 'Stop':             return 'idle'
    case 'SessionStart':     return 'idle'
  }
}

function parseBody(raw: string): CodexHookBody | null {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const sessionId = (parsed as { sessionId?: unknown }).sessionId
    const event = (parsed as { event?: unknown }).event
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    if (typeof event !== 'string') return null
    if (!PARSEABLE_EVENTS.has(event as CodexHookEvent)) return null
    return { sessionId, event: event as CodexHookEvent }
  } catch {
    return null
  }
}

export class CodexNotifyListener {
  private server: http.Server | null = null
  private boundPort: number | null = null
  private readonly opts: CodexNotifyListenerOptions
  private readonly latestBySession = new Map<string, NormalizedAgentSessionStatus>()

  constructor(opts: CodexNotifyListenerOptions) {
    this.opts = opts
  }

  /** Resolves once the listener is bound. Safe to call multiple times. */
  async start(): Promise<number> {
    if (this.boundPort != null) return this.boundPort

    const server = http.createServer((req, res) => this.handleRequest(req, res))

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })

    const address = server.address() as AddressInfo | null
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('Failed to determine codex notify listener port')
    }

    this.server = server
    this.boundPort = address.port
    return this.boundPort
  }

  getPort(): number | null {
    return this.boundPort
  }

  /** Drops any cached state for a session (e.g. when the session is killed). */
  forgetSession(sessionId: string): void {
    this.latestBySession.delete(sessionId)
  }

  /** Latest cached normalized status for a session, or null if unknown. */
  getLatest(sessionId: string): NormalizedAgentSessionStatus | null {
    return this.latestBySession.get(sessionId) ?? null
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.boundPort = null
    this.latestBySession.clear()
  }

  /** Public for testing — apply a parsed event without going through HTTP. */
  ingest(body: CodexHookBody): NormalizedAgentSessionStatus | null {
    if (this.opts.isKnownSession && !this.opts.isKnownSession(body.sessionId)) {
      return null
    }

    const state = eventToState(body.event)
    if (!state) return null

    const previous = this.latestBySession.get(body.sessionId)
    const now = Date.now()
    const next: NormalizedAgentSessionStatus = {
      sessionId: body.sessionId,
      agent: 'codex',
      state,
      authority: 'codex-hook',
      connected: true,
      lastResponsePreview: previous?.lastResponsePreview ?? '',
      lastTransitionAt: previous?.state === state ? previous.lastTransitionAt : now,
      updatedAt: now,
    }

    if (
      previous
      && previous.state === next.state
      && previous.connected === next.connected
    ) {
      return null
    }

    this.latestBySession.set(body.sessionId, next)
    this.opts.onStatusUpdate(next)
    return next
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/codex-hook') {
      res.statusCode = 404
      res.end()
      return
    }

    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      raw += chunk
      // Hard cap to keep us safe from runaway clients (the real payload is ~64B).
      if (raw.length > 8 * 1024) {
        res.statusCode = 413
        res.end()
        req.destroy()
      }
    })
    req.on('end', () => {
      const body = parseBody(raw)
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
