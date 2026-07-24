// Pure geometry-ownership reducer for the remote bridge. DOM- and electron-free
// so it can be unit-tested in the node test env; remote-bridge.ts holds one
// `GeometryOwnership` value and defers every transition to these functions.
//
// Model: a single shared PTY per session can be driven by exactly one client at
// a time. 'desktop' (default) is the legacy behavior — the desktop's fit owns
// every PTY and the phone/web scales to view. 'web' means a focused web/phone
// claimed ownership: every open PTY was resized to the phone's viewport
// (webGeometry) and the DESKTOP scales to view instead. The epoch bumps on every
// real handoff so both ends detect it even when cols/rows happen to be unchanged.

export interface Geometry {
  cols: number
  rows: number
}

export interface GeometryOwnership {
  owner: 'desktop' | 'web'
  /** The phone's claimed viewport when owner === 'web'; null when desktop drives. */
  webGeometry: Geometry | null
  epoch: number
}

export function initialOwnership(): GeometryOwnership {
  return { owner: 'desktop', webGeometry: null, epoch: 0 }
}

function saneDim(cols: number, rows: number): boolean {
  return Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0
}

export interface OwnershipTransition {
  state: GeometryOwnership
  /** True when the transition actually changed ownership/geometry (worth acting on). */
  changed: boolean
}

/**
 * A focused web/phone claims ownership at (cols, rows). A no-op when the web
 * already owns exactly that geometry — so a stream of identical claims (the phone
 * re-firing on every focus/visibility/resize tick) doesn't churn resizes or bump
 * the epoch. Garbage dimensions are rejected.
 */
export function claimWeb(state: GeometryOwnership, cols: number, rows: number): OwnershipTransition {
  if (!saneDim(cols, rows)) return { state, changed: false }
  if (
    state.owner === 'web' &&
    state.webGeometry?.cols === cols &&
    state.webGeometry?.rows === rows
  ) {
    return { state, changed: false }
  }
  return { state: { owner: 'web', webGeometry: { cols, rows }, epoch: state.epoch + 1 }, changed: true }
}

/** The desktop reclaims ownership (session clicked/opened). No-op when already desktop. */
export function reclaimDesktop(state: GeometryOwnership): OwnershipTransition {
  if (state.owner === 'desktop') return { state, changed: false }
  return { state: { owner: 'desktop', webGeometry: null, epoch: state.epoch + 1 }, changed: true }
}

export interface PlannedResize {
  sessionId: string
  cols: number
  rows: number
}

/**
 * Plan the PTY resizes that hand the sizes back to the desktop.
 *
 * The web claim resizes EVERY open PTY to one phone viewport, so reclaiming has
 * to undo that for every session too — otherwise only the terminal you happen to
 * look at next un-wraps and the rest stay at phone width, invisibly, until
 * something else resizes them. Sizes are restored per session from `snapshot`
 * (what the desktop was driving before the handoff) rather than from one
 * geometry for all, since desktop sessions legitimately differ in size.
 * Sessions missing from the snapshot fall back to `fallback` (the active
 * terminal's geometry, if the renderer handed one over); with neither, the
 * session is left out and its terminal re-fits itself when it next becomes
 * visible.
 */
export function planDesktopRestore(
  sessionIds: string[],
  snapshot: Record<string, Geometry>,
  fallback: Geometry | null,
): PlannedResize[] {
  const plan: PlannedResize[] = []
  for (const sessionId of sessionIds) {
    const geo = snapshot[sessionId] ?? fallback
    if (!geo || !saneDim(geo.cols, geo.rows)) continue
    plan.push({ sessionId, cols: geo.cols, rows: geo.rows })
  }
  return plan
}

/**
 * Overlay the authoritative geometry onto the mirrored sessions (mutates in
 * place). When the web owns, every session shares the phone's viewport; when the
 * desktop owns, each keeps its per-session desktop live geometry.
 */
export function overlaySessionGeometry<T extends { cols?: number; rows?: number }>(
  sessions: Record<string, T>,
  state: GeometryOwnership,
  liveGeometry: Record<string, Geometry>,
): void {
  if (state.owner === 'web' && state.webGeometry) {
    for (const id of Object.keys(sessions)) {
      sessions[id].cols = state.webGeometry.cols
      sessions[id].rows = state.webGeometry.rows
    }
    return
  }
  for (const [id, geo] of Object.entries(liveGeometry)) {
    if (sessions[id]) {
      sessions[id].cols = geo.cols
      sessions[id].rows = geo.rows
    }
  }
}
