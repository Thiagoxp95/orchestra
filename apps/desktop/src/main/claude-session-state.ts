// Event-sourced state machine: Claude Code hook events →
// NormalizedAgentSessionStatus updates. Authority: 'claude-hooks'.
//
// Key design points (the v2 rewrite that killed the flickering sidebar and
// false "finished" notifications):
//
//   1. Every turn gets a unique `turnId` minted on UserPromptSubmit (or
//      autonomously on the first tool-use hook when no turn is active).
//      Synthetic Stops (heartbeat, interrupt-derived) must pass the turnId
//      they observed when they armed — a mismatch means the turn they were
//      trying to close is already gone, so we drop the event instead of
//      producing a spurious idle flash.
//
//   2. Emits carry a `transition` tag:
//        'turn-started' | 'turn-ended' | 'attention' | 'status'
//      Downstream consumers (notifier) notify on `turn-ended` + `attention`
//      edges keyed by turnId, so a duplicate `turn-ended` for the same turn
//      can't double-notify and a `waitingApproval→idle` refresh can't masquerade
//      as a finish.
//
//   3. User interrupts (Esc / Ctrl+C) close the turn synchronously via
//      `noteInterrupt()`. Claude's own Stop hook is unreliable under
//      interrupt — waiting for it would leave the sidebar stuck on
//      "working" indefinitely. The synthesized close is tagged
//      `wasInterrupted: true` so the notifier can suppress the "finished"
//      toast (the user is right there, they just pressed Esc).

import { randomUUID } from 'node:crypto'
import type {
  AgentSessionState,
  AgentSessionTransition,
  NormalizedAgentSessionStatus,
} from '../shared/agent-session-types'
import type { ClaudeHookEventType } from './claude-hook-runtime'

export interface ClaudeHookEvent {
  orchestraSessionId: string
  claudeSessionId: string
  eventType: ClaudeHookEventType
  message: string
  transcriptPath?: string
  cwd?: string
  /**
   * Opaque turn identifier that the caller believes is active. Synthetic
   * Stops (heartbeat, interrupt-derived) MUST set this to the turnId they
   * observed when arming. Real hook deliveries leave it undefined; they
   * always apply against whatever turn is currently active.
   */
  expectedTurnId?: string
}

interface PerSessionState {
  current: AgentSessionState
  currentTurnId: string | null
  lastClaudeSessionId: string | null
  lastTranscriptPath: string | null
  lastCwd: string | null
}

export interface ClaudeSessionStateOptions {
  onStatusUpdate: (status: NormalizedAgentSessionStatus) => void
}

export interface ClaudeSessionState {
  applyHookEvent(event: ClaudeHookEvent): void
  onOrchestraSessionClosed(orchestraSessionId: string): void
  getCurrentState(orchestraSessionId: string): AgentSessionState | null
  getCurrentTurnId(orchestraSessionId: string): string | null
  getLastClaudeSessionId(orchestraSessionId: string): string | null
  getLastTranscriptPath(orchestraSessionId: string): string | null
  getLastCwd(orchestraSessionId: string): string | null
  /**
   * Called when the user sends an interrupt byte (Esc / Ctrl+C) to a session
   * that is currently working / waiting. Closes the current turn immediately
   * (emits `turn-ended` with `wasInterrupted: true`) so the sidebar clears.
   * No-ops when the session isn't in a live turn.
   */
  noteInterrupt(orchestraSessionId: string): void
  /**
   * Override the state to `waitingUserInput`, but only if the session is
   * currently `idle`. Used when an async classifier (Gemini) determines that
   * the last assistant message requires user input after a Stop hook.
   */
  markNeedsUserInputIfIdle(orchestraSessionId: string): void
}

type AttentionState = 'waitingApproval' | 'waitingUserInput'

function parseNotificationMessage(message: string): AttentionState | null {
  if (!message) return null
  const lower = message.toLowerCase()
  // Anchor "permission" with surrounding context to avoid false positives like
  // "ssh: permission denied" or "Permission granted". Real Claude permission
  // prompts say things like "Claude needs your permission to use Bash".
  if (
    lower.includes('needs permission') ||
    lower.includes('your permission') ||
    lower.includes('requesting permission')
  ) {
    return 'waitingApproval'
  }
  if (lower.includes('approval')) return 'waitingApproval'
  if (lower.includes('waiting for input') || lower.includes('waiting for your input')) {
    return 'waitingUserInput'
  }
  return null
}

export function createClaudeSessionState(opts: ClaudeSessionStateOptions): ClaudeSessionState {
  const sessions = new Map<string, PerSessionState>()

  function getOrCreate(orchestraSessionId: string): PerSessionState {
    let entry = sessions.get(orchestraSessionId)
    if (!entry) {
      entry = {
        current: 'unknown',
        currentTurnId: null,
        lastClaudeSessionId: null,
        lastTranscriptPath: null,
        lastCwd: null,
      }
      sessions.set(orchestraSessionId, entry)
    }
    return entry
  }

  function emit(
    orchestraSessionId: string,
    entry: PerSessionState,
    transition: AgentSessionTransition,
    extra: { wasInterrupted?: boolean } = {},
  ): void {
    const now = Date.now()
    const status: NormalizedAgentSessionStatus = {
      sessionId: orchestraSessionId,
      agent: 'claude',
      state: entry.current,
      authority: 'claude-hooks',
      connected: true,
      lastResponsePreview: '',
      lastTransitionAt: now,
      updatedAt: now,
      turnId: entry.currentTurnId ?? undefined,
      transition,
    }
    if (extra.wasInterrupted) status.wasInterrupted = true
    opts.onStatusUpdate(status)
  }

  function startTurn(orchestraSessionId: string, entry: PerSessionState): void {
    entry.currentTurnId = randomUUID()
    entry.current = 'working'
    emit(orchestraSessionId, entry, 'turn-started')
  }

  function endTurn(
    orchestraSessionId: string,
    entry: PerSessionState,
    cause: { wasInterrupted?: boolean } = {},
  ): void {
    entry.current = 'idle'
    // Keep currentTurnId on the entry through idle — a post-hoc classifier
    // promotion (`markNeedsUserInputIfIdle`) needs to re-emit under the same
    // turnId so the notifier recognises it as a same-turn attention edge,
    // not a fresh turn. The id is rotated when the next turn starts.
    emit(orchestraSessionId, entry, 'turn-ended', cause)
  }

  function applyAttention(
    orchestraSessionId: string,
    entry: PerSessionState,
    next: AttentionState,
  ): void {
    if (entry.current === 'unknown' || entry.current === 'idle') {
      // Attention arriving outside a live turn (e.g. Claude asks a question
      // before any tool-use, or classifier promotes idle → waitingUserInput
      // via the dedicated path below). Open a fresh turn so a later Stop
      // closes cleanly. markNeedsUserInputIfIdle has its own same-turn
      // promotion path and doesn't reach here.
      entry.currentTurnId = randomUUID()
    }
    if (entry.current === next) return // dedupe repeat attention
    entry.current = next
    emit(orchestraSessionId, entry, 'attention')
  }

  return {
    applyHookEvent(event: ClaudeHookEvent): void {
      const entry = getOrCreate(event.orchestraSessionId)

      entry.lastClaudeSessionId = event.claudeSessionId || entry.lastClaudeSessionId
      if (event.transcriptPath) entry.lastTranscriptPath = event.transcriptPath
      if (event.cwd) entry.lastCwd = event.cwd

      switch (event.eventType) {
        case 'UserPromptSubmit': {
          // Always starts a fresh turn (minting a new turnId).
          startTurn(event.orchestraSessionId, entry)
          return
        }
        case 'PreToolUse':
        case 'PostToolUse': {
          if (entry.current === 'unknown' || entry.current === 'idle') {
            // Autonomous heal: Claude is doing work but we aren't inside an
            // open turn (either we missed UserPromptSubmit, or the last
            // turn already closed and Claude resumed on its own). Mint a
            // fresh turn so the next Stop closes something distinct.
            startTurn(event.orchestraSessionId, entry)
            return
          }
          if (entry.current !== 'working') {
            entry.current = 'working'
            emit(event.orchestraSessionId, entry, 'status')
          }
          return
        }
        case 'PermissionRequest': {
          applyAttention(event.orchestraSessionId, entry, 'waitingApproval')
          return
        }
        case 'Notification': {
          const attn = parseNotificationMessage(event.message)
          if (attn === null) return
          applyAttention(event.orchestraSessionId, entry, attn)
          return
        }
        case 'Stop': {
          // Gate on turnId when the caller asserted one (synthetic Stops).
          // If the caller's turn is gone, the close is stale — drop it. Real
          // hook deliveries leave expectedTurnId undefined and always close
          // the current turn.
          if (
            event.expectedTurnId !== undefined &&
            event.expectedTurnId !== entry.currentTurnId
          ) {
            return
          }
          // No turn was ever opened, or we've already processed a Stop for
          // this turn (state is already idle). Either way, suppress — a
          // second turn-ended for an already-closed turn would re-notify.
          if (entry.current === 'unknown' || entry.current === 'idle') {
                    return
          }
          endTurn(event.orchestraSessionId, entry)
          return
        }
      }
    },

    noteInterrupt(orchestraSessionId: string): void {
      const entry = sessions.get(orchestraSessionId)
      if (!entry) return
      // Only close a turn that is actually live. If the session is already
      // idle / unknown, the user's interrupt byte is either a stray Esc in
      // the prompt box or arrived after Claude stopped on its own — nothing
      // to do.
      if (
        entry.current !== 'working' &&
        entry.current !== 'waitingApproval' &&
        entry.current !== 'waitingUserInput'
      ) {
        return
      }
      // Close the turn immediately so the sidebar clears. Claude's own Stop
      // hook is unreliable under interrupt, so we can't wait for it. We mark
      // the emit `wasInterrupted: true` so the notifier skips the "Claude
      // is ready" toast — the user is right there, they just hit Esc.
      endTurn(orchestraSessionId, entry, { wasInterrupted: true })
    },

    onOrchestraSessionClosed(orchestraSessionId: string): void {
      sessions.delete(orchestraSessionId)
    },

    getCurrentState(orchestraSessionId: string): AgentSessionState | null {
      return sessions.get(orchestraSessionId)?.current ?? null
    },

    getCurrentTurnId(orchestraSessionId: string): string | null {
      return sessions.get(orchestraSessionId)?.currentTurnId ?? null
    },

    getLastClaudeSessionId(orchestraSessionId: string): string | null {
      return sessions.get(orchestraSessionId)?.lastClaudeSessionId ?? null
    },

    getLastTranscriptPath(orchestraSessionId: string): string | null {
      return sessions.get(orchestraSessionId)?.lastTranscriptPath ?? null
    },

    getLastCwd(orchestraSessionId: string): string | null {
      return sessions.get(orchestraSessionId)?.lastCwd ?? null
    },

    markNeedsUserInputIfIdle(orchestraSessionId: string): void {
      const entry = sessions.get(orchestraSessionId)
      if (!entry) return
      if (entry.current !== 'idle') return
      // Re-open attention on the SAME turnId that just ended. The notifier
      // dedupes by `${turnId}::${state}` so the "finished" toast that
      // already fired for this turn is independent of the "needs input"
      // toast we're about to fire — both are welcome, the same-turn key
      // only blocks literal duplicate finishes / duplicate needs-inputs.
      if (entry.currentTurnId === null) entry.currentTurnId = randomUUID()
      entry.current = 'waitingUserInput'
      emit(orchestraSessionId, entry, 'attention')
    },
  }
}
