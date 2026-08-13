// Who gets the chat view, decided from what a session was LAUNCHED as rather
// than from what `ps` has managed to observe about it so far.
//
// processStatus alone is not knowable on a pane's first frame: the PTY spawns a
// shell, the shell needs a beat to exec `claude`/`codex`, and process-monitor's
// 1s poll honestly reports 'terminal' until it can see the agent in the process
// table. Gating chat on that signal alone is what made a brand-new agent session
// paint the raw terminal for a second before flipping to chat.
//
// The store already records the launch intent (agentLaunches, armed by
// createSession for every agent session and cleared/verified by useProcessStatus
// once the live status is known), so a pane that is *becoming* an agent is
// chat-eligible from the frame it is created in — and a launch that never
// produced an agent is dropped by that same verification, falling back to the
// terminal rather than showing an empty timeline forever.

import { isAgentSession } from './lib/agent-session'

/** The launch record the store keeps while an agent session starts up. */
export interface AgentLaunchIntent {
  agent: string
  confirmed: boolean
}

/**
 * Whether the chat view (and its Chat ⌁ Term pill) is offered for a pane.
 * True for a running agent, and for one whose launch is still being confirmed.
 * A shell/dev-server pane — and a 'cursor' pane, which has no readable
 * transcript — stays terminal-only and keeps ignoring the view preference.
 */
export function isChatAvailable(
  processStatus: string | undefined,
  launch?: AgentLaunchIntent,
): boolean {
  return isAgentSession(processStatus) || isAgentSession(launch?.agent)
}
