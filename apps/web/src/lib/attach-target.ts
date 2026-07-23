// Pure resolver for "the web fired an action — which session should it open?".
// Kept free of React/Convex imports so it can be unit-tested like the rest of src/lib.
//
// Firing an action from the web (worktree sheet, new-worktree spin-up, action bar)
// arms an attach for the workspace the action targets. Following the *target
// workspace* rather than blindly following the desktop's mirrored focus matters
// because the desktop switches workspace and tree BEFORE it spawns
// (useRemoteWorktreeActions), and the mirror's leading-edge throttle push can land
// mid-sequence — so `activeSessionId` briefly points at whatever session already
// lived in that workspace. Attaching to that and disarming stranded the phone on
// an old session (or, when the desktop's focus never moved, on the workspace it
// started in).

/** Session ids that already existed when the action fired, plus its target workspace. */
export interface PendingAttach {
  /** The workspace the fired action targets (null when the caller can't resolve one). */
  workspaceId: string | null
  known: string[]
}

export interface AttachSessionLike {
  workspaceId?: string
}

export interface AttachTarget {
  sessionId: string
  /** True once this is the session the action actually created — stop following. */
  settled: boolean
}

/**
 * How long an armed attach keeps following its target workspace before giving up.
 * Covers the desktop round-trip (command poll → workspace switch → spawn → mirror
 * push) with room for a booting agent, while bounding how long the desktop user's
 * own session switches can move the phone's view.
 */
export const ATTACH_ARM_MS = 8_000

/**
 * Resolves the session an armed attach should open, or null to keep waiting.
 *
 * A session that appeared in the target workspace since the action fired is the
 * one it created — attach and settle. Until then, the desktop's focus is followed
 * only when it lands in the target workspace AND that differs from the workspace
 * the phone is already in: that's the "take me there" jump, without yanking the
 * user off the session they're reading when the action targets their own workspace.
 */
export function resolveAttachTarget(
  pending: PendingAttach,
  sessions: Record<string, AttachSessionLike>,
  activeSessionId: string | null | undefined,
  currentWorkspaceId: string | null | undefined,
): AttachTarget | null {
  const target = pending.workspaceId
  // No resolvable target: fall back to the old behaviour — follow the desktop once.
  if (!target) return activeSessionId ? { sessionId: activeSessionId, settled: true } : null

  const known = new Set(pending.known)
  const fresh = Object.keys(sessions).filter(
    (id) => !known.has(id) && sessions[id]?.workspaceId === target,
  )
  if (fresh.length > 0) {
    // Prefer the desktop's focus when it's one of the new sessions (the action may
    // have spawned several — a worktree spin-up plus its selected actions); else the
    // most recent, since the mirrored map preserves creation order.
    const focused =
      activeSessionId && fresh.includes(activeSessionId) ? activeSessionId : fresh[fresh.length - 1]
    return { sessionId: focused, settled: true }
  }

  if (
    activeSessionId &&
    currentWorkspaceId !== target &&
    sessions[activeSessionId]?.workspaceId === target
  ) {
    return { sessionId: activeSessionId, settled: false }
  }
  return null
}
