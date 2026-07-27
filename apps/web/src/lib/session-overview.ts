// The session overview: every mirrored agent as a card, newest work first.
//
// This is what the phone shows when nothing is open — the screen you land on
// after killing a session, and the one an inward pinch pulls back to from
// anywhere (see classifyTwoFinger). The roll answers "what's next to this one";
// the overview answers "what is running right now, and which of it wants me".
//
// Ordering is working-first, then by *the agent's* last activity, not ours: the
// desktop stamps each entry from the transcript's mtime (agent-context-tracker),
// so a session that worked while the phone was in someone's pocket still sorts
// to the top. Recency breaks ties inside each group — to the displayed minute,
// not the millisecond (see RECENCY_BUCKET_MS) — so the freshest working agent
// leads the screen and the rest of the list stays as it was.
//
// Kept free of React/Convex imports so it can be unit-tested like the rest of src/lib.

import type { RollItem } from './session-roll'

/** A session's context window occupancy, ready to render. */
export interface OverviewContext {
  usedTokens: number
  contextWindow: number
  /** 0–100, clamped — a window can be overrun before a compaction lands. */
  percent: number
}

export interface OverviewItem extends RollItem {
  /** Present only for agent sessions that have taken at least one turn. */
  context: OverviewContext | null
  /** Transcript mtime, when known. The sort key. */
  activeAt: number | null
  /** Whether this is the session the phone currently has open. */
  current: boolean
}

/** True for the sessions that carry a context window: the agents. */
export function isAgentSession(processStatus: string): boolean {
  return processStatus === 'claude' || processStatus === 'codex'
}

function contextOf(item: RollItem): OverviewContext | null {
  const usedTokens = item.status?.contextTokens
  const contextWindow = item.status?.contextWindow
  if (!usedTokens || !contextWindow) return null
  return {
    usedTokens,
    contextWindow,
    percent: Math.min(100, Math.max(0, Math.round((usedTokens / contextWindow) * 100))),
  }
}

/**
 * Rank for the overview's grouping pass. Lower sorts first.
 *
 * Working sessions float above everything, because a working agent is the one
 * thing on this screen that will change without you: an agent that went quiet
 * two minutes ago is finished, while one that is still going is the reason you
 * pinched out. Recency alone can't express that — it would bury a long-running
 * agent under every session you touched since starting it.
 *
 * Exited sessions sink below everything live no matter how recently they ran —
 * their recency is the moment they *stopped* being useful, so letting it rank
 * them against live work would put the deadest card on top right after a
 * session ends. Sessions with no timestamp (shells, and agents that haven't
 * taken a turn yet) sit between: still live, but with nothing to sort by.
 */
function rank(item: RollItem): number {
  if (item.status?.exited) return 3
  // Exit wins over a stale `working` — the bridge can report both (buildLiveStatus).
  if (item.status?.work === 'working') return 0
  if (!item.status?.activeAt) return 2
  return 1
}

/**
 * Granularity the recency sort actually resolves, in ms — deliberately the same
 * minute `formatAgo` renders, because sorting finer than you display is what
 * makes a list move for no visible reason.
 *
 * `activeAt` is a live clock: the desktop takes it as max(transcript mtime, last
 * terminal output) and re-pushes the mirror every couple of hundred ms, so two
 * agents that are both working right now trade places on every single push while
 * both cards keep reading "now". Rounding the key down to the displayed minute
 * makes concurrent workers tie, and a tie falls through to sidebar order — so the
 * list holds still until something genuinely ages out of its minute.
 */
const RECENCY_BUCKET_MS = 60_000

function recencyBucket(activeAt: number | null): number {
  if (!activeAt) return 0
  return Math.floor(activeAt / RECENCY_BUCKET_MS)
}

/**
 * The agent sessions, as overview cards: working first, newest first.
 *
 * Agents only — plain shells are dropped. This screen answers "what is running
 * right now, and which of it wants me", and a shell never wants anything: it
 * has no work state to float, no context window to fill, and no turn to have
 * taken. Mixed in, they were rows that could only ever say "Idle", padding the
 * one screen whose whole job is to be scannable. The roll next door still
 * carries everything, so a terminal is one two-finger swipe away.
 *
 * Ties and untimed sessions fall back to the incoming order, which is the
 * sidebar's (workspace → worktree → session) — so the part of the list that has
 * no recency to sort by still reads the way the rest of the app is arranged
 * rather than shuffling between renders.
 */
export function buildOverview(items: RollItem[], selectedId: string | null): OverviewItem[] {
  return items
    .filter((item) => isAgentSession(item.processStatus))
    .map((item, index) => ({
      ...item,
      context: contextOf(item),
      activeAt: item.status?.activeAt ?? null,
      current: item.sessionId === selectedId,
      _rank: rank(item),
      _index: index,
    }))
    .sort(
      (a, b) =>
        a._rank - b._rank ||
        recencyBucket(b.activeAt) - recencyBucket(a.activeAt) ||
        a._index - b._index,
    )
    .map(({ _rank, _index, ...item }) => item)
}

/**
 * Token counts at a glance: `98.9k`, `1.2M`. Two significant-ish digits, because
 * the card is showing a fraction of a window — the exact token is never the
 * point, and a full `98,883` would crowd out the number it's measured against.
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens < 1_000) return String(Math.round(tokens))
  if (tokens < 1_000_000) {
    const k = tokens / 1_000
    return `${k < 100 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`
  }
  const m = tokens / 1_000_000
  return `${m < 100 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}M`
}

/**
 * How long ago, in the tersest form that still reads: `now`, `4m`, `2h`, `3d`.
 * Under a minute is "now" rather than a second count — the mirror's own push
 * cadence makes anything finer a lie.
 */
export function formatAgo(activeAt: number | null, now: number): string | null {
  if (!activeAt) return null
  const seconds = Math.max(0, Math.round((now - activeAt) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
