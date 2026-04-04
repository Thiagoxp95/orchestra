# Terminal Content Change Detection

**Date:** 2026-04-03  
**Status:** Approved

## Problem

The current activity detection system is a complex multi-layer architecture with different strategies per agent type:

- Claude: hook events + JSONL transcript parsing + structured activity polling
- Codex: hook events + session log parsing + terminal pattern matching

This creates ~8 files of detection logic, a normalized registry with authority tracking, dual IPC paths, and fallback chains. The complexity makes it fragile and hard to extend to new agent types.

## Solution

Replace the entire detection system with a single universal mechanism: **poll the last N characters of each terminal's buffer and detect changes.** If content keeps changing, the session is working. If it stops changing for 3 seconds, the session is idle.

This works for any agent type and even plain scripts — no agent-specific parsing needed.

## Design

### New Module: `terminal-activity-detector.ts`

Location: `apps/desktop/src/main/terminal-activity-detector.ts`

**State per session:**

```typescript
interface SessionActivityState {
  lastSnapshot: string
  lastChangeTime: number
  currentState: 'working' | 'idle'
}
```

**Core map:** `Map<string, SessionActivityState>` keyed by session ID.

**Polling loop (every 500ms):**

1. For each tracked session, read the last ~1000 characters from the terminal buffer
2. Compare to stored `lastSnapshot`
3. If different: update `lastSnapshot`, set `lastChangeTime = Date.now()`, transition to `working` if not already
4. If same: check if `Date.now() - lastChangeTime > 3000` ms — if so, transition to `idle`

**On state transition:** Send IPC `'session-work-state'` to renderer with `{ sessionId, state }`.

**API:**

```typescript
export function startTracking(sessionId: string): void
export function stopTracking(sessionId: string): void
export function getSnapshot(sessionId: string): string  // called by polling loop
```

The `getSnapshot` function needs access to terminal buffer content. The session watchers (or pty-manager) will register a way to read the last N chars of a session's terminal.

### Terminal Buffer Access

The pty-manager already accumulates terminal data. The detector needs a function like:

```typescript
type SnapshotProvider = (sessionId: string) => string
```

Registered at startup. Returns the last ~1000 characters of raw terminal output for a given session. This can be implemented as a ring buffer or simply slicing the tail of accumulated output.

### IPC

**Single channel:** `'session-work-state'`

```typescript
// Main → Renderer
{ sessionId: string, state: 'working' | 'idle' }
```

Replaces: `'claude-work-state'`, `'codex-work-state'`, `'agent-session-state'`

### Renderer Changes

**`app-store.ts`:**

- New state: `sessionWorkState: Record<string, 'working' | 'idle'>`
- New action: `setSessionWorkState(sessionId: string, state: 'working' | 'idle')`
- Remove: `claudeWorkState`, `codexWorkState`, `normalizedAgentState`, `sessionNeedsUserInput`, and all their setters

**`useAgentResponses.ts`:**

- Listen to single IPC channel `'session-work-state'`
- Call `setSessionWorkState` on receive
- Remove all other work-state listeners

**`Sidebar.tsx`:**

- Read `sessionWorkState` from store
- `isSessionWorking = sessionWorkState[session.id] === 'working'`
- Remove: `getSessionState`, `getLegacySessionState`, dual-path fallback logic, `normalizedAgentState` reads

### Files to Delete

| File | Reason |
|------|--------|
| `claude-activity-parser.ts` + test | JSONL parsing no longer needed |
| `claude-structured-activity.ts` + test | Structured activity polling replaced |
| `claude-terminal-activity.ts` | Terminal pattern matching replaced |
| `codex-structured-activity.ts` + test | Structured activity polling replaced |
| `codex-terminal-activity.ts` | Terminal pattern matching replaced |
| `agent-session-authority.ts` + test | Normalized registry replaced |
| `claude-hook-runtime.ts` + test | Hook event processing replaced |
| `claude-hook-server.ts` | Hook HTTP server replaced |

### Files to Modify

| File | Change |
|------|--------|
| `claude-session-watcher.ts` | Remove activity polling, hook event handling. Keep session lifecycle detection (start/stop of Claude process). Register with terminal-activity-detector. |
| `codex-session-watcher.ts` | Same as above for Codex. |
| `app-store.ts` + test | Replace multiple work-state maps with single `sessionWorkState` |
| `useAgentResponses.ts` | Single IPC listener instead of multiple |
| `Sidebar.tsx` | Simplified state reading |
| `agent-session-types.ts` + test | Simplify — remove hook event types, authority types, normalized state types |
| `preload/index.ts` | Update IPC channel registrations |

### Files to Create

| File | Purpose |
|------|--------|
| `terminal-activity-detector.ts` | Core detection module |
| `terminal-activity-detector.test.ts` | Unit tests |

### Constants

| Name | Value | Rationale |
|------|-------|-----------|
| Poll interval | 500ms | Fast enough to feel responsive, low CPU overhead |
| Snapshot size | 1000 chars | Captures enough terminal content to detect changes reliably |
| Idle timeout | 3000ms | Bridges gaps between tool calls, responsive when agent finishes |

### Edge Cases

- **Session with no terminal yet:** Skip during polling, stays in default idle state
- **Session closes:** `stopTracking()` cleans up from the map
- **Multiple rapid transitions:** The 3s idle debounce naturally absorbs these
- **Terminal resize/reflow:** May cause a brief content change, triggers "working" that self-corrects in 3s — acceptable trade-off for simplicity
- **Static long-running command** (e.g., `sleep 60`): Will appear idle after 3s since terminal content doesn't change — this is correct behavior (nothing visible is happening)

### States

Only two states: `'working'` and `'idle'`. No `waitingApproval`, `waitingUserInput`, or `error` states. The sidebar animations simplify to:

- **Working:** spinning logo + shimmer text
- **Idle:** static logo, no shimmer

## What Stays Unchanged

- Session watchers still detect when Claude/Codex processes start and stop (process lifecycle)
- Sidebar visual effects CSS (spinning, shimmer, animations)
- Terminal/pty infrastructure
- Session management and workspace model
