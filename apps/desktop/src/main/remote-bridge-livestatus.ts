// Effective per-session live status pushed to the web sidebar (shimmer + dots).
//
// Two sources feed "is this agent working":
//   - the daemon work-state TAP (`liveStatus`, mutated in remote-bridge.ts): only
//     ever sees TRANSITIONS while the bridge is running, so a session already
//     working when the bridge attached — or whose tap simply never fired — has no
//     entry and never shimmers on the web.
//   - the renderer's `computeAgentView` over its full store (claudeWorkState,
//     codexWorkState, normalizedAgentState, processStatus, needsUserInput): the
//     authoritative, complete signal the desktop sidebar itself renders from,
//     mirrored to the bridge on every store change.
//
// buildLiveStatus overlays the renderer's authoritative work onto the tap entry
// (which still carries `exited`/`label`) for EVERY live session, so the web's
// shimmer matches the desktop one instead of lighting up only the few sessions
// the tap happened to catch mid-transition.

export interface LiveStatusEntry {
  work: 'idle' | 'working'
  exited?: boolean
  label?: string
  // Whether the session is waiting on the user (reply or approval). Feeds the web
  // sidebar's workspace-level "needs input" count. Only the renderer knows this.
  attention?: 'input' | 'approval'
  // How full the agent's context window is, and when its transcript was last
  // written — the phone's session overview renders the first and sorts by the
  // second. Absent for shells and for agents that haven't taken a turn yet (see
  // agent-context-tracker).
  contextTokens?: number
  contextWindow?: number
  activeAt?: number
}

/** What the context tracker knows about one session (agent-context-tracker). */
export interface ContextEntry {
  usedTokens: number
  contextWindow: number
  updatedAt: number
}

export function buildLiveStatus(
  sessionIds: string[],
  tap: Record<string, LiveStatusEntry>,
  rendererWork: Record<string, 'idle' | 'working'>,
  rendererAttention: Record<string, 'input' | 'approval'> = {},
  context: Record<string, ContextEntry> = {},
  lastOutputAt: Record<string, number> = {},
): Record<string, LiveStatusEntry> {
  const out: Record<string, LiveStatusEntry> = {}
  for (const id of sessionIds) {
    const t = tap[id]
    // Renderer work is authoritative; fall back to the tap's last-seen work, then
    // idle. Preserve the tap's exited/label (the web reads `work==='working' &&
    // !exited`, so a re-reported 'working' on an exited session must not shimmer).
    const work = rendererWork[id] ?? t?.work ?? 'idle'
    const attention = rendererAttention[id]
    const entry: LiveStatusEntry = attention ? { ...t, work, attention } : { ...t, work }
    const ctx = context[id]
    if (ctx) {
      entry.contextTokens = ctx.usedTokens
      entry.contextWindow = ctx.contextWindow
    }
    // Two clocks, and the later one wins. Terminal output covers every session
    // (shells included) and moves the instant something prints, but it is
    // in-memory and so knows nothing from before this launch; a transcript's
    // mtime survives restarts but only exists for agents and only moves when the
    // agent writes. Taking the max means a session is dated by whichever source
    // actually saw it last, and a freshly-relaunched desktop still sorts its
    // agents sensibly instead of showing them all as undated.
    const active = Math.max(ctx?.updatedAt ?? 0, lastOutputAt[id] ?? 0)
    if (active > 0) entry.activeAt = active
    out[id] = entry
  }
  return out
}
