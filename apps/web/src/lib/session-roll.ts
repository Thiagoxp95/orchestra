// The session roll: a two-finger vertical swipe cycles through every mirrored
// session, TikTok-style, without opening the sidebar.
//
// One finger over the terminal is already spoken for — it pans xterm's scrollback,
// scrolls a full-screen TUI, and (held) starts a drag-selection. Two fingers is the
// free gesture, and it's one no browser chrome claims on a page that can't scroll.
//
// The roll is a single flat list in exactly the order the sidebar draws it —
// workspace → worktree → session — so "the next one down" means the same thing in
// both places. It spans workspaces (the point is to thumb through everything that's
// running) and wraps at both ends, so the roll never dead-ends.
//
// Kept free of React/Convex imports so it can be unit-tested like the rest of src/lib.

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
}

export interface RollStatusLike {
  work?: 'idle' | 'working'
  exited?: boolean
  label?: string
  attention?: 'input' | 'approval'
}

/** One card in the roll: everything needed to render a session's identity. */
export interface RollItem {
  sessionId: string
  label: string
  processStatus: string
  actionIcon?: string
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
  for (const ws of workspaces) {
    for (let treeIdx = 0; treeIdx < ws.trees.length; treeIdx++) {
      const tree = ws.trees[treeIdx]
      const worktree = treeLabel(tree, treeIdx === 0)
      for (const sid of tree.sessionIds) {
        const s = sessions[sid]
        if (!s || seen.has(sid)) continue
        seen.add(sid)
        const status = liveStatus[sid]
        items.push({
          sessionId: sid,
          // The mirrored liveStatus label is the fresher one (it tracks the agent's
          // current task); fall back to the session's own label. Same as the sidebar.
          label: status?.label ?? s.label,
          processStatus: s.processStatus,
          actionIcon: s.actionIcon,
          workspaceId: ws.id,
          workspaceName: ws.name,
          workspaceEmoji: ws.emoji,
          color: ws.color,
          worktree,
          status,
        })
      }
    }
  }
  return items
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

/**
 * What a two-finger gesture turned out to be, once it has moved far enough to tell.
 *
 * 'pending' — still under the lock threshold; keep watching.
 * 'roll'    — both fingers travelling vertically together: this is the gesture.
 * 'reject'  — a pinch (fingers separating faster than they travel) or a horizontal
 *             two-finger pan. Neither should move the roll.
 */
export type TwoFingerVerdict = 'pending' | 'roll' | 'reject'

export function classifyTwoFinger(dx: number, dy: number, spreadDelta: number): TwoFingerVerdict {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  const as = Math.abs(spreadDelta)
  if (Math.max(ax, ay, as) < ROLL_AXIS_LOCK_PX) return 'pending'
  if (as > ay) return 'reject'
  if (ax > ay) return 'reject'
  return 'roll'
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
