// Tiny localhost HTTP listener that the codex-notify hook posts events to.
// Maps codex hook event names to NormalizedAgentSessionStatus and hands them
// off to the supplied callback so the rest of the app can stay agnostic.
//
// The listener binds to 127.0.0.1 on an OS-assigned port; the port is exported
// so it can be injected into each codex PTY as ORCHESTRA_CODEX_HOOK_PORT.
//
// As of v1.11, the rollout JSONL watcher is the authoritative signal for
// working/idle transitions — codex's hooks are inherently best-effort (Stop is
// unreliable mid-turn, especially under /fast). The hook listener is kept for
// two reasons: (1) UserPromptSubmit gives us a fast-path optimistic "working"
// flip before the JSONL has a chance to record `task_started`, and (2)
// SessionStart carries codex's `session_id` and `transcript_path` — that's how
// the watcher learns which rollout file belongs to which orchestra session.
// Stop hooks are observed but never authoritative for the idle transition.

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
  codexSessionId?: string
  transcriptPath?: string
}

export interface CodexSessionInfo {
  sessionId: string
  codexSessionId: string
  /**
   * The rollout JSONL path codex passed in the hook payload. Optional because
   * codex sets `transcript_path: null` when the rollout hasn't been
   * materialized yet — that race burns the very first hook event of a fresh
   * session. The watcher must fall back to globbing by `codexSessionId` when
   * this is absent.
   */
  transcriptPath?: string
}

export interface CodexNotifyListenerOptions {
  /**
   * Called when the listener has authoritative new state for a session. The
   * callback should treat the value as the latest known state — duplicates
   * have already been collapsed.
   */
  onStatusUpdate: (status: NormalizedAgentSessionStatus) => void
  /**
   * Called when the listener learns codex's `session_id` + rollout
   * `transcript_path` for an orchestra session. Fired on the first hook event
   * that carries both values (typically SessionStart, but later events also
   * include them so the watcher can attach late if SessionStart is missed).
   * The callback is idempotent — fired only once per (orchestraSessionId,
   * transcriptPath) pair.
   */
  onSessionInfo?: (info: CodexSessionInfo) => void
  /** Optional check so we ignore POSTs for sessions that no longer exist. */
  isKnownSession?: (sessionId: string) => boolean
  /**
   * If true, Stop hook events are propagated to `onStatusUpdate` as `idle`. If
   * false (the default since v1.11), the rollout watcher owns the idle
   * transition and Stop hooks are recorded only for cache-coherence.
   */
  emitIdleOnStop?: boolean
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
    const body: CodexHookBody = { sessionId, event: event as CodexHookEvent }
    const codexSessionId = (parsed as { codexSessionId?: unknown }).codexSessionId
    if (typeof codexSessionId === 'string' && codexSessionId.length > 0) {
      body.codexSessionId = codexSessionId
    }
    const transcriptPath = (parsed as { transcriptPath?: unknown }).transcriptPath
    if (typeof transcriptPath === 'string' && transcriptPath.length > 0) {
      body.transcriptPath = transcriptPath
    }
    return body
  } catch {
    return null
  }
}

export class CodexNotifyListener {
  private server: http.Server | null = null
  private boundPort: number | null = null
  private readonly opts: CodexNotifyListenerOptions
  private readonly latestBySession = new Map<string, NormalizedAgentSessionStatus>()
  private readonly sessionInfoFiredFor = new Map<string, string>()
  private readonly emitIdleOnStop: boolean

  constructor(opts: CodexNotifyListenerOptions) {
    this.opts = opts
    this.emitIdleOnStop = opts.emitIdleOnStop ?? false
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
    this.sessionInfoFiredFor.delete(sessionId)
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
    this.sessionInfoFiredFor.clear()
  }

  /** Public for testing — apply a parsed event without going through HTTP. */
  ingest(body: CodexHookBody): NormalizedAgentSessionStatus | null {
    if (this.opts.isKnownSession && !this.opts.isKnownSession(body.sessionId)) {
      return null
    }

    // Surface session_id (and transcript_path when codex provides it) to the
    // watcher as soon as we see them, regardless of which event they ride on.
    // codex emits `session_id` on every hook payload but only fills
    // `transcript_path` once the rollout file has been materialized — fire on
    // codex_session_id alone so the watcher can glob the rollout by id when
    // transcript_path is absent. Dedup key combines both fields so we still
    // re-fire when transcript_path eventually arrives.
    if (body.codexSessionId) {
      const dedupKey = `${body.codexSessionId}|${body.transcriptPath ?? ''}`
      const seen = this.sessionInfoFiredFor.get(body.sessionId)
      if (seen !== dedupKey) {
        this.sessionInfoFiredFor.set(body.sessionId, dedupKey)
        const info: CodexSessionInfo = {
          sessionId: body.sessionId,
          codexSessionId: body.codexSessionId,
        }
        if (body.transcriptPath) info.transcriptPath = body.transcriptPath
        this.opts.onSessionInfo?.(info)
      }
    }

    const state = eventToState(body.event)
    if (!state) return null

    // Stop hooks are not authoritative for the idle transition — the rollout
    // watcher owns that signal because it can't be fooled by codex CLI firing
    // Stop hooks between sub-tasks of a single turn. Stop hooks are kept here
    // only so the cache stays coherent for `getLatest` consumers, and so the
    // listener can still optionally emit them when explicitly enabled (tests
    // and the legacy code path).
    if (body.event === 'Stop' && !this.emitIdleOnStop) {
      return null
    }

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

  /**
   * External path for the rollout watcher to push an authoritative state into
   * the listener's cache and propagate it to the consumer. The watcher
   * derives state from the canonical JSONL, so its signal supersedes the hook
   * stream for working/idle transitions.
   */
  applyExternalState(
    sessionId: string,
    state: AgentSessionState,
    authority: NormalizedAgentSessionStatus['authority'],
  ): NormalizedAgentSessionStatus | null {
    if (this.opts.isKnownSession && !this.opts.isKnownSession(sessionId)) {
      return null
    }
    const previous = this.latestBySession.get(sessionId)
    const now = Date.now()
    const next: NormalizedAgentSessionStatus = {
      sessionId,
      agent: 'codex',
      state,
      authority,
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
    this.latestBySession.set(sessionId, next)
    this.opts.onStatusUpdate(next)
    return next
  }

  markRunStarted(sessionId: string): NormalizedAgentSessionStatus | null {
    return this.ingest({ sessionId, event: 'UserPromptSubmit' })
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
      // Hard cap to keep us safe from runaway clients (the real payload is ~256B).
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
