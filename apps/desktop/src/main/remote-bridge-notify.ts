// Phone push gate. Two independent filters stand between "something happened in
// a session" and a notification on the phone:
//
//   1. The idle gate — sitting at the Mac suppresses phone pushes BY DESIGN.
//   2. The settle gate — the claim ("finished" / "needs input") has to still be
//      true a few seconds later, checked against the agent's CURRENT state.
//
// (2) exists because the signal that fires these notifications is the OSC
// terminal title (daemon-client.ts), which flaps: Claude's title drops to idle
// for a beat between tool calls, mid-compaction, and around subagent handoffs,
// and every one of those blips used to become a "finished" push the user opened
// their phone to find still spinning. The hook stream (claude-notify-listener)
// knows the truth but deliberately fires no notifications of its own, so it is
// consulted here instead — the claim is only allowed through if the agent is
// still at rest when the timer fires, and its needs-input/finished wording is
// re-derived from that same state rather than from the guess made 8s earlier.

import { powerMonitor } from 'electron'
import { anyApi } from 'convex/server'
import type { AgentSessionState } from '../shared/agent-session-types'
import { DEVICE_SECRET } from './convex-config'
import { getRemoteClient, isRemoteBridgeEnabled } from './remote-bridge'

/** Seconds the Mac must be idle before phone pushes fire. */
export const IDLE_THRESHOLD_SECONDS = 120

/** How long a claim must hold before the phone hears about it. Long enough to
 *  outlast an OSC title blip between tool calls, short enough that a real
 *  "needs input" still reaches the phone while the user cares. */
export const NOTIFY_SETTLE_MS = 8000

/** Pure gate: only push to the phone once the user is away from the Mac. */
export function shouldRemoteNotify(idleSeconds: number, thresholdSeconds: number): boolean {
  return idleSeconds >= thresholdSeconds
}

export interface RemoteNotifyInput {
  title: string
  body: string
  sessionId: string
  requiresUserInput: boolean
}

/** Body text the callers pass for the two generic cases. Recognised so a
 *  re-classified notification doesn't ship the other case's wording. */
const GENERIC_INPUT_BODY = 'Needs your input'
const GENERIC_FINISHED_BODY = 'Finished'

export type NotifyVerdict =
  | { send: false; reason: 'working' }
  | { send: true; requiresUserInput: boolean }

/**
 * Does the claim still hold, given what the agent is doing right now?
 *
 * - working                        → drop. The blip that fired this is over;
 *                                    the agent never stopped.
 * - waitingUserInput/waitingApproval → send as "needs input", whatever was claimed.
 * - idle                           → send as "finished", whatever was claimed. A
 *                                    needs-input guess that the agent has since
 *                                    moved past is a finished turn, not a question.
 * - unknown (no state at all)      → send the claim unchanged. Losing a real
 *                                    notification is worse than a stale one.
 */
export function resolveNotifyVerdict(
  claimedRequiresUserInput: boolean,
  current: AgentSessionState | null,
): NotifyVerdict {
  if (current === 'working') return { send: false, reason: 'working' }
  if (current === 'waitingUserInput' || current === 'waitingApproval') {
    return { send: true, requiresUserInput: true }
  }
  if (current === 'idle') return { send: true, requiresUserInput: false }
  return { send: true, requiresUserInput: claimedRequiresUserInput }
}

/** Swap generic wording when the verdict re-classified the notification. */
export function resolveNotifyBody(body: string, requiresUserInput: boolean): string {
  if (requiresUserInput && body === GENERIC_FINISHED_BODY) return GENERIC_INPUT_BODY
  if (!requiresUserInput && body === GENERIC_INPUT_BODY) return GENERIC_FINISHED_BODY
  return body
}

/** Supplies the agent's current state — the hook stream first, then the OSC
 *  scraper. Injected from index.ts, which owns the listeners. */
type StatusResolver = (sessionId: string) => AgentSessionState | null

let statusResolver: StatusResolver | null = null

export function setRemoteNotifyStatusResolver(resolver: StatusResolver | null): void {
  statusResolver = resolver
}

/** One pending push per session — a newer event replaces the older claim. */
const pending = new Map<string, ReturnType<typeof setTimeout>>()

/** Drop a session's pending push (session closed, app quitting). */
export function cancelRemoteBridgeNotify(sessionId: string): void {
  const timer = pending.get(sessionId)
  if (!timer) return
  clearTimeout(timer)
  pending.delete(sessionId)
}

function send(input: RemoteNotifyInput): void {
  void getRemoteClient()
    .mutation(anyApi.remote.notify, { secret: DEVICE_SECRET, ...input })
    .catch((err: unknown) => console.warn('[remote-bridge] notify failed:', err))
}

/**
 * Queue a phone push for an idle/needs-input event, to be confirmed against the
 * agent's state once it settles. No-op when the bridge is disabled or the user
 * is at the Mac when the timer fires. Never throws into the caller.
 */
export function remoteBridgeNotify(input: RemoteNotifyInput): void {
  if (!isRemoteBridgeEnabled()) return

  cancelRemoteBridgeNotify(input.sessionId)
  const timer = setTimeout(() => {
    pending.delete(input.sessionId)

    // Checked here rather than at queue time: the user may have walked away
    // during the settle window, and that push is still worth sending.
    const idle = powerMonitor.getSystemIdleTime()
    if (!shouldRemoteNotify(idle, IDLE_THRESHOLD_SECONDS)) return

    const current = statusResolver?.(input.sessionId) ?? null
    const verdict = resolveNotifyVerdict(input.requiresUserInput, current)
    if (!verdict.send) {
      console.log(
        '[remote-bridge] notify suppressed session=%s state=%s (claim: %s)',
        input.sessionId.slice(0, 8),
        current,
        input.requiresUserInput ? 'needs input' : 'finished',
      )
      return
    }

    send({
      ...input,
      requiresUserInput: verdict.requiresUserInput,
      body: resolveNotifyBody(input.body, verdict.requiresUserInput),
    })
  }, NOTIFY_SETTLE_MS)

  timer.unref?.()
  pending.set(input.sessionId, timer)
}
