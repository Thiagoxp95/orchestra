// The session overview: every mirrored *agent* as a card, newest work first.
// Plain shells are the sidebar's business (see buildOverview).
//
// This is what the phone shows when nothing is open — the screen you land on
// after killing a session, and the one an inward pinch pulls back to from
// anywhere (see classifyTwoFinger). The roll answers "what's next to this one";
// the overview answers "what is running right now, and which of it wants me".
//
// Ordering is by urgency — blocked-on-you first, then working, then finished —
// and inside each of those by when YOU last spoke to it: the session you just
// sent something to leads its group, and the ones you haven't touched in days
// sink. Recency breaks ties inside each group at the resolution the card
// actually prints, not the millisecond (see recencyBucket), so the rest of the
// list holds still while the top of it moves.
//
// "When you last spoke to it" is the desktop's `lastUserAt`, read out of the
// agent's own transcript (see parseLastUserMessageAt). It replaced the
// transcript's mtime, which answered a different question — when did this AGENT
// last write — and answered it in a way that read as broken on the card: an
// agent left running writes for hours after the last thing you asked it, so a
// session you messaged yesterday printed "2h" and sorted above one you'd
// messaged that morning. `activeAt` (the mtime) survives as the fallback for the
// sessions there is no message to date: a desktop too old to send the field, and
// an agent nobody has spoken to yet.
//
// Kept free of React/Convex imports so it can be unit-tested like the rest of src/lib.

import type { RollItem } from './session-roll'
import { workspaceDisplayEmoji } from './workspace-emoji'

/** The parts of a mirrored workspace a pill is built from (see RollWorkspaceLike). */
export interface PillWorkspace {
  id: string
  name: string
  color?: string
  emoji?: string
}

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
  /**
   * When this session was last *spoken to*, when known — the timestamp the card
   * prints and the list sorts on. The person's last message, falling back to the
   * transcript's mtime for a session that has none (see the header).
   */
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
 * Rank for the overview's sort. Lower sorts first.
 *
 * The screen is ordered by how much each session wants you, not by where it
 * lives:
 *
 * 0. **Blocked on you** — the agent has stopped and is holding a question or an
 *    approval. Nothing else on the screen can move until you answer, so this is
 *    the most urgent thing here and always leads, however long ago it asked.
 * 1. **Working** — the one thing that will change without you. An agent that
 *    went quiet two minutes ago is finished; one still going is the reason you
 *    pinched out. Recency alone can't express that — it would bury a
 *    long-running agent under every session you touched since starting it.
 * 2. **Finished**, newest first.
 * 3. **Nothing to sort by** — shells, and agents that haven't taken a turn.
 *    Still live, so still above the dead.
 * 4. **Exited.** Its recency is the moment it stopped being useful, so ranking
 *    that against live work would put the deadest card on top the instant a
 *    session ends.
 */
function rank(item: RollItem): number {
  // Exit wins over a stale `working`/`attention` — the bridge can report both
  // at once (buildLiveStatus), and a dead session asks nothing of anyone.
  if (item.status?.exited) return 4
  if (item.status?.attention) return 0
  if (item.status?.work === 'working') return 1
  if (!item.status?.activeAt) return 3
  return 2
}

/**
 * Granularity the recency sort actually resolves, in ms — deliberately the same
 * minute `formatAgo` renders, because sorting finer than you display is what
 * makes a list move for no visible reason.
 *
 * The fallback stamp (`activeAt`, the transcript's mtime) is a live clock: the
 * desktop re-pushes the mirror every couple of hundred ms, so two undated agents
 * that are both working right now would trade places on every single push while
 * both cards keep reading "now". Bucketing makes concurrent workers tie, and a
 * tie falls through to sidebar order — so the list holds still until something
 * genuinely ages out of its minute. A message stamp barely needs this (it moves
 * only when you send something), but two sessions messaged seconds apart are
 * still a tie the eye can't check, and the same rule covers both.
 */
const RECENCY_BUCKET_MS = 60_000

/**
 * How old this card *reads*, in whole minutes — the sort key. Lower is fresher.
 *
 * Measured as an age against the same `now` the cards render with, NOT as an
 * absolute `floor(activeAt / 60s)`: absolute buckets are pinned to wall-clock
 * minute boundaries, so two agents working 200ms apart still land either side of
 * one every time the clock rolls over, and the list flips for a moment each
 * minute while both cards plainly say "now". An age bucket ties whenever
 * `formatAgo` prints the same thing, which is the whole point — the order can
 * only change when the text does.
 *
 * Clamped at zero because the timestamp comes from the desktop's clock and is
 * read against the phone's: a few seconds of skew must not invent a negative age
 * that sorts one device's sessions above another's.
 */
function recencyBucket(activeAt: number | null, now: number): number {
  // Nothing to be fresh about — sinks to the bottom of whatever group it's in.
  if (!activeAt) return Number.MAX_SAFE_INTEGER
  return Math.floor(Math.max(0, now - activeAt) / RECENCY_BUCKET_MS)
}

/**
 * Every *agent* session, as overview cards: working first, newest first.
 *
 * Agents only — no shells (see isAgentSession). This screen answers "which of my
 * agents wants me", and every signal on a card is an agent's: the context bar,
 * the working shimmer, the blocked-on-you badge, the transcript-stamped age. A
 * terminal has none of those, so a row of them is a wall of blanks between the
 * cards that carry the answer. Shells stay one tap away in the sidebar, which is
 * the list that is *about* where things live.
 *
 * Filtering here rather than at render time is deliberate: this list is what the
 * card count, the waiting/working tallies and the workspace pills are all
 * derived from (see buildWorkspacePills), so anything dropped later would leave
 * a workspace advertising sessions this screen refuses to show.
 *
 * Ties and untimed sessions fall back to the incoming order, which is the
 * sidebar's (workspace → worktree → session) — so the part of the list that has
 * no recency to sort by still reads the way the rest of the app is arranged
 * rather than shuffling between renders.
 *
 * `now` is the clock the cards' own "3m" labels are rendered against; passing it
 * in is what keeps the order and the text from disagreeing (see recencyBucket).
 */
export function buildOverview(
  items: RollItem[],
  selectedId: string | null,
  now: number,
): OverviewItem[] {
  return items
    .filter((item) => isAgentSession(item.processStatus))
    .map((item, index) => ({
      ...item,
      context: contextOf(item),
      activeAt: item.status?.lastUserAt ?? item.status?.activeAt ?? null,
      current: item.sessionId === selectedId,
      _rank: rank(item),
      _index: index,
    }))
    .sort(
      (a, b) =>
        a._rank - b._rank ||
        recencyBucket(a.activeAt, now) - recencyBucket(b.activeAt, now) ||
        a._index - b._index,
    )
    .map(({ _rank, _index, ...item }) => item)
}

/** A workspace as a pill above the list: what to call it, and what it's up to. */
export interface OverviewPill {
  workspaceId: string
  name: string
  emoji: string
  color: string | null
  /** Agent sessions still alive in it — the count the pill carries. */
  live: number
  /** One of them is blocked on you. Same amber the cards badge with. */
  attention: boolean
  /** …or one of them is working. Only shown when nothing is asking. */
  working: boolean
}

/**
 * The workspaces, as the row of pills the list is started from.
 *
 * The cards used to be sectioned by workspace, which sorted the screen by where
 * work lives rather than by what needs doing — a workspace with one loud
 * question sat below one with three idle sessions. Now the cards are a single
 * urgency-ordered list and the workspaces move up here, where they answer the
 * other question this screen gets asked: "start me something new."
 *
 * Every workspace gets a pill, including the ones with nothing running — an
 * empty workspace is precisely the one you want to start something in, and the
 * old headers could only exist where a session already did. This is also what
 * keeps a shells-only workspace coherent now that the cards are agents only: it
 * reads as a workspace with no agents (a pill, no count), never as a heading
 * with nothing under it. They stay in
 * sidebar order (not sorted by activity) so the row is a stable set of targets
 * for the thumb rather than something that reshuffles under it.
 */
export function buildWorkspacePills(
  workspaces: PillWorkspace[],
  cards: OverviewItem[],
): OverviewPill[] {
  return workspaces.map((ws, index) => {
    const live = cards.filter((c) => c.workspaceId === ws.id && !c.status?.exited)
    return {
      workspaceId: ws.id,
      name: ws.name,
      // Same fallback the cards get (see flattenRoll), so a workspace reads
      // identically in both places.
      emoji: workspaceDisplayEmoji(ws.emoji, index),
      color: ws.color ?? null,
      live: live.length,
      attention: live.some((c) => Boolean(c.status?.attention)),
      working: live.some((c) => c.status?.work === 'working'),
    }
  })
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
