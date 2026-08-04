// Localhost HTTP listener that the claude-notify hook POSTs events to. Maps
// Claude's lifecycle hook events to NormalizedAgentSessionStatus and hands them
// to the supplied callback so the rest of the app stays agent-agnostic (the
// renderer's computeAgentView already consumes agent:'claude' normalized state).
//
// Hooks are the primary signal — instead of inferring "working" from a braille
// glyph in the terminal title, Claude reports its own state. But the hook
// stream is not complete: an interrupted turn (Esc) fires no terminal event at
// all, so the OSC-title scraper (claude-work-indicator) stays wired in as a
// reconciling second signal through applyExternalState(), not merely as a
// pre-install fallback. See that method for the override matrix.
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
//   SessionStart                                                      → no state; forwarded for
//     its transcript_path, which pairs the session with its JSONL at launch.

import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
  AgentSessionAuthority,
  AgentSessionState,
  NormalizedAgentSessionStatus,
} from '../shared/agent-session-types'

export type ClaudeHookEvent =
  | 'SessionStart'
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
  transcriptPath?: string
}

export interface ClaudeNotifyListenerOptions {
  /**
   * Called when the listener has new state for a session. Duplicates (same
   * state as the last emit) are already collapsed.
   */
  onStatusUpdate: (status: NormalizedAgentSessionStatus) => void
  /**
   * Called with the transcript Claude reports for a session. Claude Code's own
   * session id is not the orchestra one, so its hook payload is the only place
   * the pairing is stated — everything else has to guess it from the working
   * directory. Fired on every hook; consumers dedupe.
   */
  onTranscriptPath?: (sessionId: string, transcriptPath: string) => void
  /**
   * Called when a session opens an AskUserQuestion form, with the form itself.
   *
   * Separate from the status callback because it needs the hook's `tool_input`,
   * which the notify script cannot forward through its normal payload — that is
   * assembled by shell string concatenation, and `tool_input` is a nested
   * object. So the script POSTs Claude's RAW payload to /claude-question and
   * the parsing happens here, where there is a real JSON parser.
   */
  onQuestion?: (sessionId: string, toolUseId: string, toolInput: unknown) => void
  /** Optional check so we ignore POSTs for sessions that no longer exist. */
  isKnownSession?: (sessionId: string) => boolean
}

const PARSEABLE_EVENTS: ReadonlySet<ClaudeHookEvent> = new Set([
  'SessionStart',
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
    // SessionStart is consumed for its transcript_path alone (see ingest); it
    // must not steer state — its `compact` source fires mid-turn, and mapping
    // it to anything would flip a working pane.
    case 'SessionStart':
    default:
      return null
  }
}

/** Which cached states an out-of-band observation is allowed to correct. */
function canExternalStateOverride(
  cached: AgentSessionState | null,
  next: AgentSessionState,
): boolean {
  if (cached === next) return false
  switch (next) {
    // The title reports idle only once the TUI is back at the prompt — while a
    // picker (including Claude's AskUserQuestion) is up, the scraper holds
    // 'waitingUserInput' instead — so an idle title also retires a picker the
    // user has since dismissed without triggering any hook event.
    case 'idle':
      return cached === 'working' || cached === 'waitingUserInput'
    case 'waitingUserInput':
      return cached === 'working'
    case 'working':
      return cached === null || cached === 'idle'
    default:
      return false
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
    const transcriptPath = (parsed as { transcriptPath?: unknown }).transcriptPath
    if (typeof transcriptPath === 'string' && transcriptPath.length > 0) {
      body.transcriptPath = transcriptPath
    }
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
    // Report the transcript before any of the state mapping below, which returns
    // early for plenty of events — the pairing is worth having from whichever
    // hook happens to fire first, including the ones we don't map to a state.
    if (body.transcriptPath) {
      this.opts.onTranscriptPath?.(body.sessionId, body.transcriptPath)
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

  /**
   * Reconcile the hook stream against an out-of-band observation of the pane —
   * today the OSC terminal title (authority 'claude-osc').
   *
   * The hook stream has a hole: an interrupted turn (Esc) fires no Stop, no
   * StopFailure, no PostToolUse. The last event stays 'working' and the sidebar
   * shimmers on a pane that is sitting at the prompt. Claude's own title is the
   * live signal there — it flips to `✳` the moment the TUI is back at rest.
   *
   * The override matrix is deliberately narrow: the title only corrects states
   * it can actually observe, and it never clears a "needs you" state that only
   * the hook stream can see.
   *   title idle             + cached working → idle   (interrupt, dropped Stop)
   *   title idle       + cached waitingUserInput → idle (picker dismissed)
   *   title waitingUserInput + cached working → waitingUserInput  (TUI picker)
   *   title working          + cached idle/-- → working (hooks silent: never
   *                                                     installed, or the PTY
   *                                                     holds a stale port from
   *                                                     a previous app run)
   */
  applyExternalState(
    sessionId: string,
    state: AgentSessionState,
    authority: AgentSessionAuthority,
  ): NormalizedAgentSessionStatus | null {
    if (this.opts.isKnownSession && !this.opts.isKnownSession(sessionId)) {
      return null
    }

    const cached = this.latestBySession.get(sessionId)?.state ?? null
    if (!canExternalStateOverride(cached, state)) return null

    const session = this.getOrCreateSession(sessionId)
    if (state === 'idle') {
      // The TUI is back at the prompt, so nothing the hook stream still thinks
      // is in flight can be running — including subagents whose SubagentStop
      // never arrived, which would otherwise defer every future lead Stop.
      session.roster.clear()
    }
    session.leadState = state

    return this.emit(sessionId, state, authority)
  }

  private emit(
    sessionId: string,
    state: AgentSessionState,
    authority: AgentSessionAuthority = 'claude-hook',
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
      authority,
      connected: true,
      lastResponsePreview: previous?.lastResponsePreview ?? '',
      lastTransitionAt: previous?.state === state ? previous.lastTransitionAt : now,
      updatedAt: now,
    }
    this.latestBySession.set(sessionId, next)
    this.opts.onStatusUpdate(next)
    return next
  }

  /**
   * Claude's raw PreToolUse payload for an AskUserQuestion. The session id
   * rides a header (it comes from the PTY env, not from Claude's payload) so
   * the body can be forwarded verbatim.
   */
  private handleQuestion(raw: string, sessionId: string | undefined): void {
    if (!sessionId) return
    if (this.opts.isKnownSession && !this.opts.isKnownSession(sessionId)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    const payload = parsed as Record<string, unknown>
    // Pair the form with the transcript record that will carry it later.
    const toolUseId = payload.tool_use_id
    if (typeof toolUseId !== 'string' || !toolUseId) return
    if (!isAskUserQuestionTool(payload.tool_name as string | undefined)) return
    // Deliberately does NOT report transcript_path. The mapped /claude-hook
    // POST for this same PreToolUse event already carries it, and reporting it
    // here would be actively harmful: a path the mirror hasn't seen yet is a
    // conversation SWAP, and noteSwap empties the pending buffer — throwing away
    // the very question enqueued on the next line. Observed while probing.
    this.opts.onQuestion?.(sessionId, toolUseId, payload.tool_input)
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const isQuestion = req.url === '/claude-question'
    if (req.method !== 'POST' || (req.url !== '/claude-hook' && !isQuestion)) {
      res.statusCode = 404
      res.end()
      return
    }

    // A question form carries the whole option list (with previews), so it gets
    // a far larger ceiling than the ~256B mapped payload.
    const cap = isQuestion ? 256 * 1024 : 8 * 1024
    const sessionHeader = req.headers['x-orchestra-session']
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      raw += chunk
      // Hard cap to stay safe from runaway clients.
      if (raw.length > cap) {
        res.statusCode = 413
        res.end()
        req.destroy()
      }
    })
    req.on('end', () => {
      if (isQuestion) {
        this.handleQuestion(raw, typeof sessionHeader === 'string' ? sessionHeader : undefined)
        res.statusCode = 204
        res.end()
        return
      }
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
