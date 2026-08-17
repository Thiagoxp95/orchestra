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

import { parseLaunchSelection } from '../shared/launch-selection'
import { detectTuiPrompt, type TuiPrompt } from './tui-prompt-detector'

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
  // The model and reasoning effort the agent is currently running, as its own
  // transcript records them — the phone's model picker shows these as the
  // session's current values (see agent-context.ts). Before the first turn
  // there is no transcript, so these fall back to the launch command's flags
  // (parseLaunchSelection).
  model?: string
  effort?: string
  // Whether this session's transcript has been found and read — i.e. whether
  // there is a conversation the phone can render. Absent for shells and for an
  // agent whose transcript hasn't paired yet; the phone withholds its chat view
  // until it turns true (see AgentMessageMirror.onPaired).
  chatReady?: boolean
  // A TUI-native prompt currently on this session's screen (folder trust, tool
  // permission) that has no transcript record and no hook, scraped from the
  // terminal buffer so the phone can render + answer it as a card. Absent when
  // no such prompt is showing. See tui-prompt-detector.ts.
  tuiPrompt?: TuiPrompt
}

/** What the context tracker knows about one session (agent-context-tracker). */
export interface ContextEntry {
  usedTokens: number
  contextWindow: number
  updatedAt: number
  model?: string
  effort?: string
}

export function buildLiveStatus(
  sessionIds: string[],
  tap: Record<string, LiveStatusEntry>,
  rendererWork: Record<string, 'idle' | 'working'>,
  rendererAttention: Record<string, 'input' | 'approval'> = {},
  context: Record<string, ContextEntry> = {},
  lastOutputAt: Record<string, number> = {},
  chatReady: Record<string, boolean> = {},
  // The session's ANSI-stripped terminal buffer tail, for TUI-prompt scraping.
  // Injected so this stays pure/testable; the caller passes getTerminalBufferText.
  readScreen: (sessionId: string) => string = () => '',
  // Each session's launch command, for the pre-first-turn model/effort fallback
  // (parseLaunchSelection). Unsanitized sessions only — buildSessionMap keeps
  // initialCommand out of what the phone receives.
  initialCommands: Record<string, string | undefined> = {},
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
      if (ctx.model) entry.model = ctx.model
      if (ctx.effort) entry.effort = ctx.effort
    }
    // No transcript yet (or one that names only half the pair) — fill the gap
    // from the launch flags so a brand-new agent doesn't mirror empty pills.
    // Transcript values always win: they carry any switch made since launch.
    if (!entry.model || !entry.effort) {
      const launched = parseLaunchSelection(initialCommands[id])
      if (!entry.model && launched.model) entry.model = launched.model
      if (!entry.effort && launched.effort) entry.effort = launched.effort
    }
    // Two clocks, and the agent's own record wins — this is "when did this agent
    // last say something", which is what the phone's overview prints.
    //
    // A transcript's mtime moves only when the agent writes, and it survives a
    // desktop restart. Terminal output moves when ANYTHING prints, and a TUI
    // prints for reasons that have nothing to do with the agent: every open PTY
    // is resized when a phone claims geometry (resizeAllSessions), and every TUI
    // repaints on the SIGWINCH. Taking the max let that repaint date the session,
    // so picking up the phone restamped a whole screen of long-idle agents to the
    // same instant and every card read "now" — the timestamps came back from the
    // mirror in identical-second clusters, one per resize, which is the tell.
    //
    // So output is the fallback, not a rival: it dates the sessions that have no
    // transcript to be dated by (shells, and agents that haven't taken a turn —
    // the tracker only records a session once it can parse a usage snapshot).
    const active = ctx?.updatedAt ?? lastOutputAt[id] ?? 0
    if (active > 0) entry.activeAt = active
    // Stamped for every AGENT session, including the `false` of one still
    // waiting for its pairing: the web reads a missing field as "desktop too old
    // to know" and keeps its chat, so "not ready" has to be said out loud. Shell
    // sessions are simply absent from the map — nothing to say about them.
    if (id in chatReady) entry.chatReady = chatReady[id]
    // A live folder-trust / permission prompt on the screen, scraped from the
    // buffer — the phone renders it as a card. Only for sessions the tap knows
    // (agents); a bare shell showing "do you trust" prose shouldn't card.
    if (t && !t.exited) {
      const prompt = detectTuiPrompt(readScreen(id))
      if (prompt) entry.tuiPrompt = prompt
    }
    out[id] = entry
  }
  return out
}
