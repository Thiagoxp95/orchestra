# Granular Agent Activity Detection via OSC Title + Pattern Matching

**Date:** 2026-04-03
**Status:** Approved

## Problem

The current activity detection system is binary — it knows `working` or `idle` based on terminal content changes. Users want to see *what* the agent is doing: thinking, executing a tool, waiting for permission, stalled, etc. There is no official API for Claude Code's internal state; it's a CLI that renders to a terminal.

## Solution

Two detection layers with graceful fallback:

1. **OSC Title Interceptor** — Claude Code animates the terminal title (via OSC 0/2 escape sequences) while working and sets it static when done. This is the primary working/idle signal — intentional, stable, and already flowing through our pty data stream.
2. **Buffer Pattern Classifier** — when working, scan the visible terminal buffer for known patterns to determine the sub-state (thinking, tool_executing, permission_request, etc.). If no pattern matches, fall back to generic "working".

### Why OSC Title

- Claude Code deliberately animates the terminal title with spinner frames (`⠂`, `⠐`) while a query is active
- Visible in terminals like Ghostty as a bouncing dot on the tab
- Stable signal — title animation is core UX, unlikely to change silently
- Already flowing through the pty data stream; currently stripped and discarded by `terminal-output-buffer.ts`

### Why Pattern Matching as Sub-State Only

- Pattern matching on terminal text is inherently fragile (screen-scraping)
- Claude Code may change spinner verbs, UI layout, or tool display at any time
- By making patterns optional enrichment rather than the load-bearing signal, we degrade gracefully: worst case shows "Working" instead of "Thinking"

## State Definitions

8 states, classified in priority order (first match wins):

| State | Priority | Detection Method | Description |
|-------|----------|-----------------|-------------|
| `idle` | — | OSC title static + no content change for 3s | Waiting for user input |
| `interrupted` | 1 | "Interrupted" in buffer tail | User interrupted the agent |
| `permission_request` | 2 | Yes/No dialog pattern in buffer tail | Agent asking for approval |
| `stalled` | 3 | Title animating but content frozen for 10s | Agent stuck or hanging |
| `thinking` | 4 | Spinner chars + thinking verbs in buffer tail | Agent reasoning |
| `tool_executing` | 5 | Tool name patterns near spinner chars | Agent running a tool |
| `turn_complete` | 6 | Past-tense verb + "for Xs" pattern | Agent finished a turn |
| `working` | 7 | Title animating, no sub-state matched | Generic working fallback |

### State Type

```typescript
type ActivityState =
  | 'idle'
  | 'interrupted'
  | 'permission_request'
  | 'stalled'
  | 'thinking'
  | 'tool_executing'
  | 'turn_complete'
  | 'working'
```

## Architecture

### New Module: `terminal-title-tracker.ts`

Hooks into raw pty data before ANSI stripping. Extracts OSC 0/2 title sequences.

**Responsibilities:**
- Parse OSC escape sequences from raw pty data: `ESC ] 0 ; <title> BEL` and `ESC ] 2 ; <title> BEL`
- Track per-session: `{ lastTitle: string, lastTitleChangeAt: number }`
- Expose `isTitleAnimating(sessionId): boolean` — true if title changed within last 1000ms
- Expose `getLastTitle(sessionId): string`

**Integration point:** `feedTerminalOutput` in `terminal-output-buffer.ts` calls a hook with the raw data before stripping. The title tracker registers this hook.

### New Module: `activity-classifier.ts`

Pure function, no state, easily testable.

```typescript
function classifyActivity(buffer: string): ActivityState | null
```

Runs pattern matching in priority order on the buffer text. Returns first match or `null` (caller uses `'working'` as default).

**Patterns:**

1. `interrupted` — `/Interrupted/` in last 200 chars
2. `permission_request` — Yes/No option patterns, tool confirmation dialog text in last 500 chars
3. `thinking` — spinner chars `[✢✳✶✻✽*·]` combined with thinking verbs (subset of ~20: "Thinking", "Pondering", "Contemplating", "Reasoning", "Cogitating", "Synthesizing", etc.) in last 300 chars
4. `tool_executing` — tool name keywords `(Read|Write|Edit|Bash|Glob|Grep|WebFetch|WebSearch|Agent|Glob|Search)` near spinner chars in last 300 chars
5. `turn_complete` — past-tense verb + `for \d+(\.\d+)?s` in last 200 chars (e.g., "Baked for 5s", "Worked for 2.3s")

`stalled` is not detected by the classifier — it's detected by the activity detector when the title is animating but buffer content hasn't changed for 10 seconds.

### Modified: `terminal-activity-detector.ts`

Replaces binary content-change logic with the classifier.

**Tick logic (every 500ms):**

```
tick(sessionId):
  titleAnimating = isTitleAnimating(sessionId)
  buffer = getSnapshot(sessionId)
  contentChanged = buffer !== lastSnapshot

  if contentChanged:
    lastSnapshot = buffer
    lastContentChangeAt = now

  if !titleAnimating && !contentChanged && (now - lastContentChangeAt > 3000):
    → emit 'idle'
  elif titleAnimating && !contentChanged && (now - lastContentChangeAt > 10000):
    → emit 'stalled'
  elif titleAnimating || contentChanged:
    subState = classifyActivity(buffer)
    → emit subState ?? 'working'
  else:
    // Title not animating but content recently changed — still settling
    subState = classifyActivity(buffer)
    → emit subState ?? 'idle'
```

**Fallback when OSC title is not available** (non-Claude sessions, or if Claude Code stops using OSC titles): falls back to pure content-change detection — same behavior as the current system. `isTitleAnimating` returns false, so detection relies on `contentChanged` only.

### Modified: `terminal-output-buffer.ts`

Add a pre-strip hook mechanism:

```typescript
type RawDataHook = (sessionId: string, rawData: string) => void

export function onRawTerminalData(hook: RawDataHook): void
```

Called from `feedTerminalOutput` before `stripAnsi`. The title tracker registers here to intercept OSC sequences from the raw stream.

### Modified: IPC + Renderer

**IPC channel** `session-work-state` payload changes:

```typescript
// Before
{ sessionId: string, state: 'working' | 'idle' }

// After
{ sessionId: string, state: ActivityState }
```

**Store** `sessionWorkState: Record<string, ActivityState>` — type widens.

**Sidebar SessionItem** changes:
- `isWorking` derived from `state !== 'idle'`
- New `statusText` prop showing human-readable state label
- `permission_request` triggers existing bounce/attention animation

### Sidebar Display Mapping

| State | Icon Animation | Status Text | Attention Indicator |
|-------|---------------|-------------|-------------------|
| `idle` | static | (none) | — |
| `thinking` | spin | "Thinking" | — |
| `tool_executing` | spin | "Executing tool" | — |
| `working` | spin | "Working" | — |
| `permission_request` | bounce | "Permission needed" | colored dot |
| `interrupted` | static | "Interrupted" | — |
| `turn_complete` | static | "Done" (fades after 3s) | — |
| `stalled` | slow pulse | "Stalled" | — |

## Graceful Degradation

| Scenario | Behavior |
|----------|----------|
| Claude Code changes spinner verbs | Sub-states degrade to "Working" |
| Claude Code changes UI patterns entirely | Sub-states degrade to "Working" |
| Claude Code stops OSC title animation | Falls back to content-change detection (current behavior) |
| Non-agent terminal sessions | Content-change detection only, no sub-states |
| Pattern classifier throws | Caught, returns null, falls back to "Working" |

## Files Summary

### Create
| File | Purpose |
|------|---------|
| `terminal-title-tracker.ts` + test | OSC title extraction and animation tracking |
| `activity-classifier.ts` + test | Pure-function pattern matching for sub-states |

### Modify
| File | Change |
|------|--------|
| `terminal-output-buffer.ts` | Add `onRawTerminalData` hook mechanism |
| `terminal-activity-detector.ts` + test | Replace binary logic with classifier integration |
| `app-store.ts` | Widen `sessionWorkState` type to `ActivityState` |
| `Sidebar.tsx` | Add status text display, map states to animations |
| `SessionItem.tsx` | Accept and render `statusText` prop |
| `shared/types.ts` | Add `ActivityState` type, update IPC types |
| `preload/index.ts` | Update IPC payload type |

### Delete
None.

## Constants

| Name | Value | Rationale |
|------|-------|-----------|
| Poll interval | 500ms | Same as current, sub-millisecond pattern matching cost |
| Title animation window | 1000ms | Title considered "animating" if changed within last 1s |
| Idle timeout | 3000ms | Same as current — 3s no change + title static → idle |
| Stalled timeout | 10000ms | Title animating but no content for 10s → something's wrong |
| Buffer scan size | 1000 chars | Last 1000 chars of stripped text for pattern matching |
| Turn complete fade | 3000ms | "Done" status text fades after 3s in sidebar |
