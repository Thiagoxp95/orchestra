/**
 * Chat only makes sense over a conversation we can actually read. A pane running
 * a dev server, a build, or a bare shell has no agent transcript behind it, so
 * the chat view (and its Chat ⌁ Term pill) is withheld there rather than offered
 * and then answered with "No agent is running".
 *
 * The signal is the process status the monitor already publishes: it stays
 * 'claude'/'codex' for the life of the agent CLI, including after its last turn,
 * so a finished conversation is still readable — it flips off only when the
 * agent is genuinely gone from the pane.
 */
export function isAgentSession(processStatus: string | undefined): boolean {
  return processStatus === 'claude' || processStatus === 'codex'
}
