// Localhost HTTP listener that the claude-notify hook POSTs events to. Maps
// Claude's lifecycle hook events to NormalizedAgentSessionStatus and hands them
// to the supplied callback so the rest of the app stays agent-agnostic (the
// renderer's computeAgentView already consumes agent:'claude' normalized state).
//
// This is the authoritative replacement for the OSC-title spinner-glyph
// heuristic (claude-work-indicator): instead of inferring "working" from a
// braille glyph in the terminal title, Claude reports its own state over
// managed hooks. The title scraper remains as the fallback for the pre-install
// window and any session whose hooks never fire.
//
// The listener binds to 127.0.0.1 on an OS-assigned port; the port is exported
// so it can be injected into each PTY as ORCHESTRA_CLAUDE_HOOK_PORT.
//
// Event → Orchestra state (see agent-hook-listener.ts:2503-2515 in stablyai/orca
// for the upstream mapping this mirrors, split here into Orchestra's finer
// waitingApproval / waitingUserInput vocabulary):
//   UserPromptSubmit | Pre/PostToolUse | PostToolUseFailure            → working
//   PreToolUse of an AskUserQuestion tool                              → waitingUserInput
//   PermissionRequest                                                 → waitingApproval
//   Stop | StopFailure                                                → idle
//   SubagentStart/Stop, TeammateIdle                                  → roster bookkeeping;
//     a pane stays 'working' while background children outlive the lead's turn.

import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
  AgentSessionState,
  NormalizedAgentSessionStatus,
} from '../shared/agent-session-types'

export type ClaudeHookEvent =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'Stop'
  | 'StopFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TeammateIdle'

interface ClaudeHookBody {
  sessionId: string
  event: ClaudeHookEvent
  toolName?: string
  agentId?: string
  agentType?: string
}

export interface ClaudeNotifyListenerOptions {
  /**
   * Called when the listener has new state for a session. Duplicates (same
   * state as the last emit) are already collapsed.
   */
  onStatusUpdate: (status: NormalizedAgentSessionStatus) => void
  /** Optional check so we ignore POSTs for sessions that no longer exist. */
  isKnownSession?: (sessionId: string) => boolean
}

const PARSEABLE_EVENTS: ReadonlySet<ClaudeHookEvent> = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
])

const SUBAGENT_LIFECYCLE_EVENTS: ReadonlySet<ClaudeHookEvent> = new Set([
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
])

/** True for Claude's structured "pick an option" tool. Mirrors orca's
 *  isAskUserQuestionTool: normalize away punctuation/case so `AskUserQuestion`
 *  and any `ask_user_question` spelling both match. */
function isAskUserQuestionTool(toolName: string | undefined): boolean {
  const normalized = toolName?.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
  return normalized === 'askuserquestion' || normalized === 'requestuserinput'
}

/** Lead-origin (non-subagent) event → state, or null for events we don't map. */
function leadStateForEvent(
  event: ClaudeHookEvent,
  toolName: string | undefined,
): AgentSessionState | null {
  switch (event) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return 'working'
    case 'PreToolUse':
      // Claude's auto-allowed AskUserQuestion arrives as a PreToolUse (its
      // Notification hook isn't registered) while blocked on a human answer —
      // surface that as waiting, not a spinner.
      return isAskUserQuestionTool(toolName) ? 'waitingUserInput' : 'working'
    case 'PermissionRequest':
      return 'waitingApproval'
    case 'Stop':
    case 'StopFailure':
      return 'idle'
    default:
      return null
  }
}

interface SessionState {
  /** Active subagent/teammate ids; a non-empty roster keeps the pane working. */
  roster: Set<string>
  /** The lead session's own last state (subagent-origin events never set it). */
  leadState: AgentSessionState
}

function parseBody(raw: string): ClaudeHookBody | null {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const sessionId = (parsed as { sessionId?: unknown }).sessionId
    const event = (parsed as { event?: unknown }).event
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    if (typeof event !== 'string') return null
    if (!PARSEABLE_EVENTS.has(event as ClaudeHookEvent)) return null
    const body: ClaudeHookBody = { sessionId, event: event as ClaudeHookEvent }
    const toolName = (parsed as { toolName?: unknown }).toolName
    if (typeof toolName === 'string' && toolName.length > 0) body.toolName = toolName
    const agentId = (parsed as { agentId?: unknown }).agentId
    if (typeof agentId === 'string' && agentId.length > 0) body.agentId = agentId
    const agentType = (parsed as { agentType?: unknown }).agentType
    if (typeof agentType === 'string' && agentType.length > 0) body.agentType = agentType
    return body
  } catch {
    return null
  }
}

export class ClaudeNotifyListener {
  private server: http.Server | null = null
  private boundPort: number | null = null
  private readonly opts: ClaudeNotifyListenerOptions
  private readonly latestBySession = new Map<string, NormalizedAgentSessionStatus>()
  private readonly sessions = new Map<string, SessionState>()

  constructor(opts: ClaudeNotifyListenerOptions) {
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
      throw new Error('Failed to determine claude notify listener port')
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
    this.sessions.delete(sessionId)
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
    this.sessions.clear()
  }

  private getOrCreateSession(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = { roster: new Set(), leadState: 'idle' }
      this.sessions.set(sessionId, session)
    }
    return session
  }

  /** Public for testing — apply a parsed event without going through HTTP. */
  ingest(body: ClaudeHookBody): NormalizedAgentSessionStatus | null {
    if (this.opts.isKnownSession && !this.opts.isKnownSession(body.sessionId)) {
      return null
    }
    const session = this.getOrCreateSession(body.sessionId)

    // Subagent/teammate lifecycle: bookkeeping only, never the lead's state.
    if (SUBAGENT_LIFECYCLE_EVENTS.has(body.event)) {
      if (body.event === 'SubagentStart') {
        if (body.agentId) session.roster.add(body.agentId)
        return this.emit(body.sessionId, 'working')
      }
      // SubagentStop / TeammateIdle: retire the child. If any children remain,
      // the pane stays working; otherwise fall back to the lead's own state (a
      // deferred idle now resolves, or the lead is still mid-turn).
      if (body.agentId) session.roster.delete(body.agentId)
      const effective = session.roster.size > 0 ? 'working' : session.leadState
      return this.emit(body.sessionId, effective)
    }

    const mapped = leadStateForEvent(body.event, body.toolName)
    if (!mapped) return null

    // Child-origin tool activity carries agent_id (the lead's events don't).
    // Keep the child tracked and the pane alive, but never let a child retire
    // or steer the lead — except a child that needs a human, which we surface.
    if (body.agentId) {
      session.roster.add(body.agentId)
      if (mapped === 'waitingApproval' || mapped === 'waitingUserInput') {
        return this.emit(body.sessionId, mapped)
      }
      return this.emit(body.sessionId, 'working')
    }

    // Lead-origin event: it owns leadState. A lead Stop isn't 'idle' while
    // subagents/teammates still run — Claude re-wakes the lead, so a later
    // empty-roster event resolves to idle (leadState is stashed as idle).
    session.leadState = mapped
    const effective = mapped === 'idle' && session.roster.size > 0 ? 'working' : mapped
    return this.emit(body.sessionId, effective)
  }

  private emit(
    sessionId: string,
    state: AgentSessionState,
  ): NormalizedAgentSessionStatus | null {
    const previous = this.latestBySession.get(sessionId)
    if (previous && previous.state === state && previous.connected) {
      return null
    }
    const now = Date.now()
    const next: NormalizedAgentSessionStatus = {
      sessionId,
      agent: 'claude',
      state,
      authority: 'claude-hook',
      connected: true,
      lastResponsePreview: previous?.lastResponsePreview ?? '',
      lastTransitionAt: previous?.state === state ? previous.lastTransitionAt : now,
      updatedAt: now,
    }
    this.latestBySession.set(sessionId, next)
    this.opts.onStatusUpdate(next)
    return next
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/claude-hook') {
      res.statusCode = 404
      res.end()
      return
    }

    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      raw += chunk
      // Hard cap to stay safe from runaway clients (the real payload is ~256B).
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
