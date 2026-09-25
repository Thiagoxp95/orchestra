// The session roll: a two-finger vertical swipe cycles through every mirrored
// session, TikTok-style, without opening the sidebar.
//
// One finger over the terminal is already spoken for — it pans xterm's scrollback,
// scrolls a full-screen TUI, and (held) starts a drag-selection. Two fingers is the
// free gesture, and it's one no browser chrome claims on a page that can't scroll.
// The same two fingers swiped rightward open the sidebar drawer, and leftward close
// the open session (see classifyTwoFinger) — so the whole surface is one gesture on
// two axes: vertical moves between sessions, horizontal acts on the one you're in.
// (Three fingers is spoken for too — pinched, they set the terminal's font size; see
// lib/terminal-font. Both this handler and the terminal's own drop whatever they had
// in flight the moment a third finger lands, so the gestures never overlap.)
//
// The roll is a single flat list in exactly the order the sidebar draws it —
// workspace → worktree → session — so "the next one down" means the same thing in
// both places. It spans workspaces (the point is to thumb through everything that's
// running) and wraps at both ends, so the roll never dead-ends.
//
// Kept free of React/Convex imports so it can be unit-tested like the rest of src/lib.

import { workspaceDisplayEmoji } from './workspace-emoji'

export interface RollTreeLike {
  rootDir: string
  sessionIds: string[]
  displayName?: string
  branch?: string
}

export interface RollWorkspaceLike {
  id: string
  name: string
  color?: string
  emoji?: string
  trees: RollTreeLike[]
}

export interface RollSessionLike {
  label: string
  processStatus: string
  workspaceId: string
  actionIcon?: string
  /** Pinned by the user; groups above the rest of its worktree everywhere. */
  pinned?: boolean
  /** A user-typed title. Outranks both `label` and the live status label. */
  customLabel?: string
}

/**
 * What to call a session on screen.
 *
 * `label` is the session's spawn label and `status.label` tracks the last prompt
 * sent to the agent — the right default, and the wrong thing the moment someone
 * deliberately names a session. So a user-typed `customLabel` wins over both,
 * permanently, and clearing it hands the name back to the auto label. Every web
 * surface that names a session (sidebar row, header, roll card, overview card)
 * goes through this, and it mirrors the desktop's own sessionDisplayLabel.
 */
export function sessionDisplayLabel(
  session: { label: string; customLabel?: string } | undefined,
  status?: { label?: string },
): string {
  const custom = session?.customLabel?.trim()
  if (custom) return custom
  return status?.label ?? session?.label ?? ''
}

export interface RollStatusLike {
  work?: 'idle' | 'working'
  exited?: boolean
  label?: string
  attention?: 'input' | 'approval'
  /** Tokens occupying the agent's context window (see agent-context-tracker). */
  contextTokens?: number
  /** …and the window they're measured against. Absent for shells. */
  contextWindow?: number
  /** When the agent's transcript was last written. The overview's fallback
   *  timestamp, for a session nobody has messaged yet. */
  activeAt?: number
  /** When the person last sent this agent a message — the overview's timestamp
   *  and sort key (see agent-context's parseLastUserMessageAt). Absent from a
   *  desktop older than the field. */
  lastUserAt?: number
  /** The model/effort the agent currently runs, as its transcript records them.
   *  Mirrored for the overview; not rendered by the roll. */
  model?: string
  effort?: string
}

/** One card in the roll: everything needed to render a session's identity. */
export interface RollItem {
  sessionId: string
  label: string
  processStatus: string
  actionIcon?: string
  /** Pinned by the user — the overview badges it and sorts it to the front. */
  pinned?: boolean
  workspaceId: string
  workspaceName: string
  workspaceEmoji?: string
  /** The workspace color, which tints the card exactly like the desktop chrome. */
  color?: string
  /** The worktree (branch) the session lives in. */
  worktree: string
  status?: RollStatusLike
}

/**
 * Label for a worktree, matching the sidebar: the base tree (index 0) shows its
 * checked-out branch and never the workspace display name (which would just repeat
 * the workspace header), worktrees prefer branch → display name → folder.
 */
function treeLabel(tree: RollTreeLike, isBase: boolean): string {
  const folder = tree.rootDir.split('/').filter(Boolean).pop() ?? tree.rootDir
  if (isBase) return tree.branch ?? folder
  return tree.branch ?? tree.displayName ?? folder
}

/**
 * One worktree's session ids with the pinned ones first, each block keeping its
 * existing relative order. Ordering is computed rather than stored, so unpinning
 * drops a session back exactly where it was. Sessions the mirror hasn't described
 * yet count as unpinned rather than being dropped — the caller skips them.
 */
export function orderTreeSessions(
  sessionIds: string[],
  sessions: Record<string, { pinned?: boolean }>,
): string[] {
  const pinned: string[] = []
  const rest: string[] = []
  for (const sid of sessionIds) {
    if (sessions[sid]?.pinned) pinned.push(sid)
    else rest.push(sid)
  }
  return pinned.length === 0 ? sessionIds : [...pinned, ...rest]
}

/**
 * Flatten the mirrored state into the roll's running order (sidebar order).
 * Sessions the mirror hasn't described yet are skipped, as are duplicates — a
 * session listed under two trees must still get exactly one slot, or the index
 * arithmetic below would stall on it.
 */
export function flattenRoll(
  workspaces: RollWorkspaceLike[],
  sessions: Record<string, RollSessionLike>,
  liveStatus: Record<string, RollStatusLike>,
): RollItem[] {
  const items: RollItem[] = []
  const seen = new Set<string>()
  for (let wsIdx = 0; wsIdx < workspaces.length; wsIdx++) {
    const ws = workspaces[wsIdx]
    for (let treeIdx = 0; treeIdx < ws.trees.length; treeIdx++) {
      const tree = ws.trees[treeIdx]
      const worktree = treeLabel(tree, treeIdx === 0)
      // Pinned sessions lead their worktree, in their existing relative order —
      // the same grouping the sidebar draws, so "the next one down" still means
      // the same thing in both places.
      for (const sid of orderTreeSessions(tree.sessionIds, sessions)) {
        const s = sessions[sid]
        if (!s || seen.has(sid)) continue
        seen.add(sid)
        const status = liveStatus[sid]
        items.push({
          sessionId: sid,
          // A user-typed name wins; otherwise the mirrored liveStatus label is the
          // fresher one (it tracks the agent's current task), then the session's
          // own label. Same as the sidebar.
          label: sessionDisplayLabel(s, status),
          processStatus: s.processStatus,
          actionIcon: s.actionIcon,
          pinned: s.pinned,
          workspaceId: ws.id,
          workspaceName: ws.name,
          workspaceEmoji: workspaceDisplayEmoji(ws.emoji, wsIdx),
          color: ws.color,
          worktree,
          status,
        })
      }
    }
  }
  return items
}

/** One entry in a "which worktree?" picker: where to spawn, and what to call it. */
export interface TreeOption {
  treeIndex: number
  label: string
}

/**
 * A workspace's worktrees as picker entries, labelled exactly as the sidebar and
 * the cards label them — so the tree you pick here reads the same as the branch
 * printed on the card that sent you.
 */
export function treeOptions(ws: RollWorkspaceLike): TreeOption[] {
  return ws.trees.map((tree, treeIndex) => ({ treeIndex, label: treeLabel(tree, treeIndex === 0) }))
}

/** Position of a session in the roll, or -1 when it isn't in it (or none is open). */
export function rollIndex(items: RollItem[], sessionId: string | null): number {
  if (!sessionId) return -1
  return items.findIndex((it) => it.sessionId === sessionId)
}

/**
 * The session `delta` steps along the roll (+1 = the next one down), wrapping at
 * both ends. With nothing open yet, a downward step lands on the first session and
 * an upward step on the last — so the gesture also works as "open something".
 */
export function rollNeighbor(
  items: RollItem[],
  sessionId: string | null,
  delta: 1 | -1,
): RollItem | null {
  if (items.length === 0) return null
  const i = rollIndex(items, sessionId)
  if (i < 0) return delta === 1 ? items[0] : items[items.length - 1]
  if (items.length === 1) return null
  return items[(i + delta + items.length) % items.length]
}

/** How long the card takes to slide into place. Mirrored by the CSS transition. */
export const ROLL_ANIM_MS = 260

/** Movement (px) before a two-finger gesture is classified as a roll, pinch, or pan. */
export const ROLL_AXIS_LOCK_PX = 12

/** Fraction of the viewport a drag must cover to commit. */
export const ROLL_COMMIT_RATIO = 0.15

/** Floor on that distance, so a commit on a short viewport still takes intent. */
export const ROLL_COMMIT_MIN_PX = 44

/** A flick this fast (px/ms) commits regardless of distance covered. */
export const ROLL_FLICK_VELOCITY = 0.4

/** …as long as it moved at least this far, so a two-finger tap can't commit. */
export const ROLL_FLICK_MIN_PX = 20

/** Rightward travel (px) before a two-finger swipe pulls the drawer open. */
export const DRAWER_OPEN_PX = 56

/**
 * Leftward travel (px) before a two-finger swipe closes the open session. Held
 * equal to DRAWER_OPEN_PX on purpose: the horizontal axis is one gesture with two
 * directions, and a threshold that differed by direction would read as the gesture
 * being unreliable rather than as a deliberate guard.
 */
export const CLOSE_SESSION_PX = 56

/**
 * Fingers drawn this much closer together before the pinch pulls back to the
 * overview. Far larger than the axis lock — the lock only decides *which*
 * gesture is in flight, and a two-finger touch that drifts a dozen pixces closed
 * while settling must not throw the terminal away. Calibrated as a deliberate
 * squeeze rather than a twitch.
 */
export const OVERVIEW_PINCH_PX = 64

/**
 * What a two-finger gesture turned out to be, once it has moved far enough to tell.
 *
 * 'pending'  — still under the lock threshold; keep watching.
 * 'roll'     — both fingers travelling vertically together: cycle sessions.
 * 'drawer'   — …travelling rightward together: pull the sidebar out, the same axis
 *              the drawer itself slides on.
 * 'close'    — …travelling leftward together: push the open session away, the same
 *              direction the sidebar's swipe-to-trash uses on a row.
 * 'overview' — a pinch inward: zoom out of the session you're in to the grid of
 *              all of them, the same thing the gesture means everywhere else on
 *              the phone.
 * 'reject'   — a pinch outward. There is nothing to zoom *into* from a session —
 *              it already fills the screen — so the gesture is left alone.
 */
export type TwoFingerVerdict = 'pending' | 'roll' | 'drawer' | 'close' | 'overview' | 'reject'

export function classifyTwoFinger(dx: number, dy: number, spreadDelta: number): TwoFingerVerdict {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  const as = Math.abs(spreadDelta)
  if (Math.max(ax, ay, as) < ROLL_AXIS_LOCK_PX) return 'pending'
  if (as > ay && as > ax) return spreadDelta < 0 ? 'overview' : 'reject'
  if (ax > ay) return dx > 0 ? 'drawer' : 'close'
  return 'roll'
}

/**
 * Whether an inward pinch has closed far (or fast) enough to pull back to the
 * overview. Fires mid-gesture like the drawer and close pulls — the screen it
 * lands on is a full replacement, so waiting for the fingers to lift would only
 * make the gesture feel late.
 */
export function overviewCommit(spreadDelta: number, elapsedMs: number): boolean {
  return pullCommit(-spreadDelta, elapsedMs, OVERVIEW_PINCH_PX)
}

/**
 * Shared distance-or-flick test for the horizontal pulls. `travel` is the distance
 * covered in the gesture's own direction, so each caller passes a positive number
 * and the sign lives at the call site rather than in here.
 */
function pullCommit(travel: number, elapsedMs: number, threshold: number): boolean {
  if (travel >= threshold) return true
  const velocity = elapsedMs > 0 ? travel / elapsedMs : 0
  return velocity >= ROLL_FLICK_VELOCITY && travel >= ROLL_FLICK_MIN_PX
}

/**
 * Whether a rightward two-finger drag has gone far (or fast) enough to open the
 * drawer. Checked while the fingers are still down — the drawer has its own slide
 * animation, so waiting for the release would make the gesture feel late.
 */
export function drawerCommit(dx: number, elapsedMs: number): boolean {
  return pullCommit(dx, elapsedMs, DRAWER_OPEN_PX)
}

/**
 * Whether a leftward two-finger drag has gone far (or fast) enough to close the
 * open session. Fires mid-drag like the drawer rather than on release: the session
 * is gone either way, and waiting for the lift only delays the feedback.
 *
 * This kills the PTY — see SessionRoll for why it is still gated on there being a
 * session to close, and page.tsx for what the phone does with the empty screen.
 */
export function closeCommit(dx: number, elapsedMs: number): boolean {
  return pullCommit(-dx, elapsedMs, CLOSE_SESSION_PX)
}

/**
 * Which way (if at all) a released drag should move the roll: +1 for the next
 * session down, -1 for the previous, 0 to snap back.
 *
 * Swiping *up* (negative dy — content dragged toward the top of the screen) brings
 * the next session up from below, exactly like a video feed.
 */
export function rollCommit(dy: number, height: number, elapsedMs: number): 1 | 0 | -1 {
  const distance = Math.abs(dy)
  const velocity = elapsedMs > 0 ? distance / elapsedMs : 0
  const far = distance >= Math.max(ROLL_COMMIT_MIN_PX, height * ROLL_COMMIT_RATIO)
  const flick = velocity >= ROLL_FLICK_VELOCITY && distance >= ROLL_FLICK_MIN_PX
  if (!far && !flick) return 0
  return dy < 0 ? 1 : -1
}
