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
}

export function buildLiveStatus(
  sessionIds: string[],
  tap: Record<string, LiveStatusEntry>,
  rendererWork: Record<string, 'idle' | 'working'>,
): Record<string, LiveStatusEntry> {
  const out: Record<string, LiveStatusEntry> = {}
  for (const id of sessionIds) {
    const t = tap[id]
    // Renderer work is authoritative; fall back to the tap's last-seen work, then
    // idle. Preserve the tap's exited/label (the web reads `work==='working' &&
    // !exited`, so a re-reported 'working' on an exited session must not shimmer).
    const work = rendererWork[id] ?? t?.work ?? 'idle'
    out[id] = { ...t, work }
  }
  return out
}
