# Last User Message Banner — Design

**Date:** 2026-04-23
**Status:** Approved (pending written review)

## Problem

In Claude and Codex sessions, the most recent prompt the user sent scrolls out of view as the agent responds. Users lose visibility into "what did I just ask?" — especially in long-running agent turns. We want a persistent, glanceable reference for the last user message in every AI agent session.

## Goal

Pin the most recent user message from the active agent session at the top of the terminal pane as a thin, always-visible banner. Applies to both Claude Code and Codex sessions (same sessions where the AI tool icon shows on the sidebar).

## Non-Goals

- Editing or resending the message from the banner
- A history of past user messages
- A banner for non-AI terminal sessions
- Re-introducing Claude hook infrastructure (HTTP server, heartbeat, hook installer) — file tailing only

## Architecture

### 1. Detection (main process)

Extend the two existing transcript watchers — no new file-watching infrastructure.

**Codex:**
- `codex-session-watcher.ts` already parses rollout files via `codex-rollout-parser.ts` and tracks thread state.
- Add extraction of the most recent genuine user message to that pipeline.
- Emit on the existing thread-state broadcast (or a sibling event).

**Claude:**
- Add a minimal `claude-transcript-reader.ts` (file-tail only — no hooks, no HTTP server, no heartbeat).
- Wire it into the same place `claude-work-indicator.ts` already discovers and tails Claude JSONL transcripts.
- Extract the most recent `role: "user"` entry whose content is not a `tool_result` and is not system-injected.

Both paths emit IPC events on a single channel:

```
session:last-user-message → { sessionId: string, text: string, timestamp: number }
```

### 2. Filtering "real" user messages

A message is shown only if it is a genuine user-typed prompt.

**Claude JSONL:** entry where `role === "user"` AND content is text (not a `tool_result` block) AND text does not consist solely of `<system-reminder>` / hook-injected content. If a message contains a mix of system-reminder blocks and a real user prompt, strip the system-reminder blocks and show only the user-authored portion.

**Codex rollout:** the existing parser already distinguishes user prompts from tool messages and assistant turns — reuse that classification.

### 3. IPC bridge

- `preload/index.ts` — expose `onSessionLastUserMessage(handler)` returning an unsubscribe function (matches existing subscription patterns in this file).
- `renderer/src/env.d.ts` — type the new method on `window.electronAPI`.

### 4. Renderer state

- Add `lastUserMessageBySession: Map<string, { text: string; timestamp: number }>` to an existing zustand store if a session-state store already exists; otherwise create `lastMessageStore.ts`.
- Subscribe once at app mount (e.g., in `App.tsx` alongside other IPC subscriptions).

### 5. UI

New component: `apps/desktop/src/renderer/src/components/LastMessageBanner.tsx`.

Mounted above the xterm container in the session pane (find the existing terminal container component — likely `SessionItem` or a sibling pane component — and render the banner directly above it).

**Visual:**
- Single line, ~28px tall.
- Truncated with ellipsis (`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`).
- Subtle background tinted with the session's workspace color (low alpha overlay on the dark theme bg).
- Small "you said:" or quote-mark prefix to make the role obvious.
- Hidden entirely when no message has been captured for the session yet.

**Interaction:**
- Hover → native tooltip (`title` on a wrapping `<span>`, since hugeicons-react doesn't accept `title`) showing the full text.
- Click → expands inline to full text with `max-height` + internal scroll; click again to collapse.
- Expansion state is local component state, not persisted.

### 6. Update semantics

- Banner reflects the latest detected user message at all times.
- Never auto-clears while the session is open.
- Persists across agent reply cycles.
- Replaced when a newer user message is detected.
- Cleared from the renderer store only when the session is closed.

## Testing

**Unit tests (main):**
- `extractLastUserMessage` for Claude JSONL — fixtures including: plain user message, message with embedded `<system-reminder>`, tool_result entry (must skip), interleaved assistant entries (must skip), empty file.
- Equivalent for Codex rollout, leveraging existing parser.

**Component test (renderer):**
- `LastMessageBanner` — empty state (renders nothing), collapsed state (truncated), expanded state (full text + scroll), hover tooltip.

## Open Questions

None — all resolved during brainstorming (Q1: hybrid B; Q2: file-tail OK; Q3: thin sticky; Q4: never auto-clear; Q5: piggyback existing watchers).

## Out of Scope

- Multi-message history in the banner
- Banner-driven message editing or resend
- Non-AI session banners
- Reviving Claude hooks/HTTP infrastructure
