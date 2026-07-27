// The session overview: every mirrored session as a card, newest work first.
//
// This is what the phone shows when nothing is open — the screen you land on
// after killing a session, and the one an inward pinch pulls back to from
// anywhere (see classifyTwoFinger). The roll answers "what's next to this one";
// the overview answers "what is running right now, and which of it wants me".
//
// Ordering is by *the agent's* last activity, not ours: the desktop stamps each
// entry from the transcript's mtime (agent-context-tracker), so a session that
// worked while the phone was in someone's pocket still sorts to the top.
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
 * Exited sessions sink below everything live no matter how recently they ran —
 * their recency is the moment they *stopped* being useful, so letting it rank
 * them against live work would put the deadest card on top right after a
 * session ends. Sessions with no timestamp (shells, and agents that haven't
 * taken a turn yet) sit between: still live, but with nothing to sort by.
 */
function rank(item: RollItem): number {
  if (item.status?.exited) return 2
  if (!item.status?.activeAt) return 1
  return 0
}

/**
 * Every mirrored session as an overview card, newest first.
 *
 * Ties and untimed sessions fall back to the incoming order, which is the
 * sidebar's (workspace → worktree → session) — so the part of the list that has
 * no recency to sort by still reads the way the rest of the app is arranged
 * rather than shuffling between renders.
 */
export function buildOverview(items: RollItem[], selectedId: string | null): OverviewItem[] {
  return items
    .map((item, index) => ({
      ...item,
      context: contextOf(item),
      activeAt: item.status?.activeAt ?? null,
      current: item.sessionId === selectedId,
      _rank: rank(item),
      _index: index,
    }))
    .sort((a, b) => a._rank - b._rank || (b.activeAt ?? 0) - (a.activeAt ?? 0) || a._index - b._index)
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
