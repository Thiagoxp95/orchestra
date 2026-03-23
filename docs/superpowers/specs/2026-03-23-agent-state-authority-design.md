# Agent State Authority Design

## Overview

Replace Orchestra's brittle sidebar activity detection with explicit, per-session authority sources.

Today, the renderer infers agent state from a mix of terminal output, PTY title parsing, JSONL parsing, rollout logs, and watcher heuristics. That creates false idle states, missed busy states, and UI drift from what the native Claude and Codex interfaces are actually doing.

The new model is:

- Codex sessions launched by Orchestra use `codex app-server` as the primary source of truth for session state.
- Claude sessions launched by Orchestra stay on the native CLI, but hook events become the primary source of truth for session state.
- Existing watcher logic remains only as session-scoped fallback during rollout and failure cases.

This design preserves the native interactive TUI for both agents while moving the sidebar and Maestro UI onto a normalized session-state model owned by the main process.

## Problem Statement

The current detection stack is structurally brittle:

- Multiple sources can author the same UI state.
- The renderer consumes partially overlapping state (`claudeWorkState`, `codexWorkState`, `sessionNeedsUserInput`, responses, terminal fallbacks).
- The sidebar asks terminal-driven heuristics to answer questions that should come from the agent runtime itself.
- Codex already exposes a richer app-server protocol than the current watcher path is using.
- Claude already emits explicit hook events, but those events are not treated as authoritative enough.

This produces visible failures:

- active agent work not reflected in the sidebar
- false idle transitions
- approval/input states hidden or delayed
- renderer state drifting from main-process watcher state

## Goals

- Make agent status come from a single authoritative source per session.
- Preserve the native Codex and Claude TUIs in terminal panes.
- Represent `working`, `waitingApproval`, `waitingUserInput`, `idle`, and degraded/error states explicitly.
- Make fallback measurable and explicit rather than silently normal.
- Keep rollout safe by retaining session-scoped fallback paths until the new authority model proves stable.

## Non-Goals

- Replacing the native Claude CLI with the Anthropic SDK.
- Replacing the native Codex TUI with a custom Orchestra UI.
- Removing all watcher logic in the first rollout.
- Reworking unrelated terminal/session architecture.

## Normalized Session State Model

Introduce one normalized agent-state record per agent session in the main process and renderer store.

```ts
type AgentSessionAuthority =
  | 'codex-app-server'
  | 'claude-hooks'
  | 'codex-watcher-fallback'
  | 'claude-watcher-fallback'

type AgentSessionState =
  | 'unknown'
  | 'working'
  | 'waitingApproval'
  | 'waitingUserInput'
  | 'idle'
  | 'error'

interface NormalizedAgentSessionStatus {
  sessionId: string
  agent: 'claude' | 'codex'
  state: AgentSessionState
  authority: AgentSessionAuthority
  connected: boolean
  degradedReason?: string
  lastResponsePreview: string
  lastTransitionAt: number
  updatedAt: number
}
```

Rules:

- each Orchestra agent session has exactly one authoritative state producer at a time
- fallback is session-scoped, not global
- the renderer consumes only normalized agent state for activity/approval/input display
- legacy fields can be derived during migration, but they stop being independently authored by multiple sources

## State Ownership

### Main Process

The main process becomes the source of truth for:

- authority selection
- normalized agent-state transitions
- degraded/fallback decisions
- app-server connectivity state
- hook-authority freshness

### Renderer

The renderer becomes a pure consumer of normalized session state for:

- sidebar spinners and attention badges
- Maestro pane header state
- session ordering by attention
- debug overlays

The renderer should not ask the terminal buffer, watcher internals, or process status heuristics whether an agent is working.

## Codex Design

### Primary Authority: `codex app-server`

Add a singleton `CodexAppServerManager` in the main process.

Responsibilities:

- start and monitor a local `codex app-server --listen ws://127.0.0.1:<port>` child process
- maintain one internal websocket/JSON-RPC client from Orchestra to the app server
- create, resume, and track Codex threads for Orchestra sessions
- normalize server notifications into `NormalizedAgentSessionStatus`
- expose debug state and degraded reasons

### Session Mapping

Maintain:

- `orchestraSessionId -> codexThreadId`
- `codexThreadId -> orchestraSessionId`

This mapping is the bridge between Orchestra sessions and Codex runtime state.

### Codex Launch Flow

For a new Orchestra Codex session:

1. Ensure the local app server is running and connected.
2. Call `thread/start` with:
   - `cwd`
   - approval policy
   - sandbox policy
   - model/config overrides as needed
3. Store the returned `threadId` for the Orchestra session.
4. Launch the terminal pane with native Codex TUI attached to that remote thread:

```bash
codex resume --remote ws://127.0.0.1:<port> <threadId>
```

This preserves the native TUI while moving authoritative session state to the app server.

### Codex State Mapping

Map app-server thread status to normalized state:

- `thread.status = idle` -> `idle`
- `thread.status = active` with no flags -> `working`
- `thread.status = active` with `waitingOnApproval` -> `waitingApproval`
- `thread.status = active` with `waitingOnUserInput` -> `waitingUserInput`
- `thread.status = systemError` -> `error`
- `thread.status = notLoaded` -> `unknown`

Reference verified from generated app-server types:

- `ThreadStatus = notLoaded | idle | systemError | active`
- `ThreadActiveFlag = waitingOnApproval | waitingOnUserInput`

### Codex Event Handling

Primary state driver:

- `thread/status/changed`

Secondary evidence and debug visibility:

- `thread/started`
- `turn/started`
- `turn/completed`
- `item/started`
- `item/completed`
- request/approval callbacks
- tool user-input callbacks

Important rule:

- terminal parsing is not part of the normal path once app-server authority is active

### Codex Response Preview

Update `lastResponsePreview` from app-server item/assistant events, not from terminal scraping.

Existing rollout parsing may remain as fallback preview recovery while the new path is being introduced, but it should not be authoritative when app-server state is healthy.

### Codex Fallback Rules

Fallback is allowed only when app-server authority is unavailable for a given session:

- app-server fails to start
- Orchestra cannot connect to the app server
- thread creation fails
- thread state stream disconnects for that session

In those cases:

- switch that session to `codex-watcher-fallback`
- set `connected = false`
- set `degradedReason`
- keep the native TUI alive
- continue surfacing session state from the existing watcher stack

In dev mode:

- keep the old watcher path running in shadow
- report mismatches between app-server authority and watcher fallback
- never let shadow state override the authoritative state

## Claude Design

### Primary Authority: Hook Events

Claude remains on the native CLI.

The current hook server and hook runtime already emit explicit events:

- `Start`
- `Stop`
- `PermissionRequest`

The architectural change is to make those events authoritative for session state.

### Claude State Mapping

Normalized mapping:

- `markClaudeSessionStarted(sessionId)` -> optimistic `working` during launch grace
- hook `Start` -> `working`
- hook `PermissionRequest` -> `waitingApproval`
- hook `Stop` -> `idle`

Claude does not currently expose a first-class user-input request equivalent in this design, so no `waitingUserInput` state is expected from Claude unless a future hook/runtime surface adds it.

### Claude Fallback Inputs

The existing watcher stack remains available only as fallback:

- JSONL parsing for response extraction and durable last-message recovery
- terminal-title parsing for fallback work-state hints
- terminal-buffer idle detection as a last-resort idle recovery path

These sources must not override a fresh hook-derived state.

### Claude Authority Rules

- if a fresh hook event exists, hook authority wins
- JSONL/title/terminal may fill gaps only when hook authority is absent, stale, or unavailable
- fallback transitions must set authority to `claude-watcher-fallback`
- degraded sessions must surface a reason in debug output

### Claude Approval UI

Claude approval becomes first-class in the normalized model rather than being special-cased outside it. This lets shared renderer components handle Claude and Codex consistently.

## Renderer Changes

### Shared Rendering Rule

Sidebar and Maestro should render only from `NormalizedAgentSessionStatus`.

UI mapping:

- `working` -> spinner/shimmer
- `waitingApproval` -> approval badge
- `waitingUserInput` -> reply badge
- `idle` -> idle checkmark/quiet state
- `error` -> error styling
- `unknown` -> neutral/loading state

### Migration Strategy in Renderer

During rollout, legacy fields can remain in the store, but renderer components should be migrated to read:

- `normalizedAgentSessionStatus[sessionId]`

instead of directly branching on:

- `claudeWorkState`
- `codexWorkState`
- `sessionNeedsUserInput`

Legacy values can be derived from normalized state temporarily for code that has not yet been migrated.

## Main Process Components

### New

- `apps/desktop/src/main/codex-app-server-manager.ts`
  - process lifecycle
  - websocket/JSON-RPC client
  - thread/session mapping
  - notification normalization

- `apps/desktop/src/main/agent-session-authority.ts`
  - normalized state registry
  - authority selection
  - fallback/degraded transitions
  - shared state mapping helpers

### Modified

- `apps/desktop/src/main/index.ts`
  - initialize app-server manager
  - expose normalized state and debug info over IPC

- `apps/desktop/src/main/codex-session-watcher.ts`
  - downgrade to fallback/shadow role for Codex
  - stop acting as the primary source for new Orchestra Codex sessions

- `apps/desktop/src/main/claude-session-watcher.ts`
  - treat hook events as the authoritative Claude state path
  - keep title/JSONL/terminal logic fallback-only

- `apps/desktop/src/main/claude-hook-server.ts`
  - no major protocol change required
  - may need light integration with the normalized state registry

- `apps/desktop/src/shared/types.ts`
  - add normalized state types and IPC payloads

- renderer store and consumers
  - add normalized agent-state storage
  - migrate sidebar/Maestro rendering

## Fallback and Degraded Mode

Each agent session should expose:

- `state`
- `authority`
- `connected`
- `degradedReason`
- `lastTransitionAt`
- `updatedAt`

Properties of fallback behavior:

- session-scoped
- explicit
- debuggable
- measurable

One broken session must not force all agent sessions onto fallback.

## Observability and Debugging

Expand debug reporting to include:

- normalized state
- authoritative source
- connected/disconnected state
- degraded reason
- shadow/fallback state when available
- mismatch summaries

Mismatch reporting should cover:

- Codex app-server state vs Codex watcher fallback
- Claude hook-authoritative state vs Claude fallback watcher state

## Rollout Plan

### Phase 1: Normalization Layer

- add normalized agent-session state types and store shape
- make current renderer status UI consume normalized state
- adapt current watcher outputs to feed the normalized model

### Phase 2: Codex App-Server Authority

- add `CodexAppServerManager`
- start new Orchestra Codex sessions via `thread/start`
- attach native TUI via `codex resume --remote`
- make app-server the authoritative Codex state source
- keep watcher fallback and dev shadow comparison

### Phase 3: Claude Hook Authority

- move Claude state ownership to hooks-first logic
- treat `PermissionRequest` as explicit `waitingApproval`
- demote JSONL/title/terminal logic to fallback-only

### Phase 4: Cleanup

- evaluate mismatch rates and degraded-session frequency
- remove dead heuristic paths once confidence is high
- keep only narrowly justified fallback behavior

## Testing Plan

### Unit Tests

- app-server `ThreadStatus` -> normalized state mapping
- Claude hook event -> normalized state mapping
- fallback precedence logic
- authority switching logic

### Codex Integration Tests

- app-server start failure falls back to watcher authority
- app-server disconnect mid-session degrades correctly without killing the TUI
- `thread/status/changed` drives `working`, `waitingApproval`, `waitingUserInput`, and `idle`
- response previews update from app-server events

### Claude Integration Tests

- `Start -> PermissionRequest -> Stop` yields `working -> waitingApproval -> idle`
- fresh hook events cannot be overridden by title/terminal fallback
- missing hooks still allow fallback recovery

### Renderer Tests

- sidebar item renders from normalized state only
- Maestro pane header renders from normalized state only
- session ordering by attention uses normalized state
- no direct dependency on legacy status branches for displayed activity state

### Debug Tests

- mismatch reports include authority and degraded reason
- degraded sessions report the correct fallback source

## Success Criteria

- if the native agent UI is visibly busy, the sidebar matches without depending on terminal heuristics in the normal path
- Codex approval/input state comes from app-server events
- Claude approval state comes from hook events
- fallback remains available but is visibly degraded and measurable
- the renderer no longer combines multiple competing state sources to decide whether an agent is active

## Risks

- `codex app-server` is still experimental, so fallback must stay during rollout
- remote TUI attachment may have edge cases around reconnect/resume semantics
- Claude hooks are stronger than current heuristics, but wrapper bypass or hook-server failures still need graceful fallback
- migration may uncover renderer paths that still read legacy fields directly

## Open Questions

No open product questions remain for this design.

The remaining uncertainty is implementation and rollout quality, which is addressed through fallback, dev-mode shadow comparison, and staged removal of heuristic paths.
