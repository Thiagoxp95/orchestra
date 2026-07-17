# Session Resurrect History — Design

**Date:** 2026-07-17
**Status:** Approved (pending spec review)

## Problem

Agent sessions (Claude Code, Codex, Cursor) are sometimes killed by mistake —
via the per-session kill, "clear tree," or worktree removal. Today the record is
destroyed with no way back: `deleteSession`, `deleteAllSessions`, and
`removeWorktree` all delete the session and every associated bit of state. The
conversation is gone from the user's reach even though the agent's transcript
often still exists on disk.

We want a one-click way to bring a killed agent session back — resuming the exact
conversation when its worktree still exists, or restarting a fresh agent of the
same type on `main` when the worktree/path was deleted.

## User-facing behavior

A new **↺ history button** lives in the header, immediately to the left of the
diff button (`App.tsx`, the `absolute right-3` diff button becomes `right-3`
with the history button offset left of it). Clicking it opens a scrollable
dropdown listing **recently-killed agent sessions in the current workspace**,
newest first.

Scope (locked during brainstorming):

- **Agent sessions only** — Claude / Codex / Cursor. Plain terminal sessions are
  never recorded.
- **Current workspace only** — the list shows sessions killed in the active
  workspace.
- **Resume coverage:** Claude resumes deterministically; Codex resumes
  best-effort (when its native id was captured); Cursor and any unknown agent
  restart fresh.

Each row shows: agent icon, session label, the worktree/branch it ran in, a
relative kill-time ("12m ago"), and a subtle indicator when the directory no
longer exists (a "· main" hint signalling it will restart on main).

Clicking a row **resurrects** the session:

- **Worktree/path still exists** → resume in place using the native session id
  and the agent's bypass flags.
- **Worktree/path was deleted** → spawn a **fresh** agent of the same type in the
  **repo root (main)**.

## Verified CLI commands

Confirmed against installed binaries — **Claude Code 2.1.212**, **codex-cli
0.144.1**:

| Purpose | Command |
|---|---|
| Claude launch (deterministic id) | `claude --dangerously-skip-permissions --session-id <uuid>` |
| Claude resume | `claude --resume <uuid> --dangerously-skip-permissions` |
| Claude fallback (path exists, no captured id) | `claude --continue --dangerously-skip-permissions` |
| Codex resume | `codex resume <uuid> --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort="…" -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true` |
| Cursor (no resume) | fresh `agent --force --model composer-2-fast` |

Relevant confirmed flags:

- `claude --session-id <uuid>` — "Use a specific session ID for the conversation
  (must be a valid UUID)." Orchestra's `generateId()` is `crypto.randomUUID()`,
  which is a valid UUID.
- `claude -r/--resume [value]` — resume by session id.
- `claude -c/--continue` — continue the most recent conversation in the current
  directory.
- `codex resume [OPTIONS] [SESSION_ID] [PROMPT]` — SESSION_ID is a UUID; accepts
  `-c`, `-m/--model`, `-s/--sandbox`, and `--dangerously-bypass-approvals-and-sandbox`.

## Data model

New persisted, **desktop-only** structure (not mirrored to web/phone — matches
the existing "schedule config is desktop-only" precedent).

```ts
interface SessionHistoryEntry {
  id: string              // = Orchestra session id (also the Claude session id — see below)
  workspaceId: string
  agentType: 'claude' | 'codex' | 'cursor'
  label: string           // display name at kill time, e.g. "Claude 3"
  cwd: string             // the worktree path the session ran in
  repoRootDir: string     // workspace main tree rootDir — where "start on main" spawns
  resumeId?: string       // native resume id: Claude uuid (== id) or captured Codex rollout uuid
  agentModel?: string
  agentReasoningEffort?: AgentReasoningEffort
  killedAt: number
}
```

- Stored on `PersistedData` as `sessionHistory: SessionHistoryEntry[]`, saved
  through the existing `saveState` path.
- **Not** included in `mirrorState` (desktop-only).
- **Retention:** cap at the **last 50 per workspace**. The array is global;
  display filters by `workspaceId`. When adding an entry would exceed the cap for
  a workspace, drop that workspace's oldest entry first.
- **Dedup by `id`:** resurrecting an entry and later re-killing it refreshes the
  same entry (updated `killedAt`) rather than creating a duplicate.

## Capture points

A single store helper records history:

```ts
recordSessionsToHistory(sessions: TerminalSession[]): void
```

It filters to agent sessions (`processStatus` in `claude | codex | cursor`) and
upserts a `SessionHistoryEntry` for each. It is called from all three
session-destroying store actions:

- `deleteSession` (single kill)
- `deleteAllSessions` (clear tree)
- `removeWorktree` (worktree removed — the primary "path was deleted" case)

Centralizing capture means any future kill path only needs to call this one
helper.

`repoRootDir` is resolved at capture time from the session's workspace
`trees[0].rootDir`, so "start on main" works even if the workspace layout later
changes.

## Native session-id capture (the resume key)

### Claude — deterministic

At launch, Orchestra injects `--session-id <orchestraSessionId>` into the Claude
command. Because the Orchestra session id is already a valid UUID, the Orchestra
id **becomes** the Claude session id — resume needs no transcript scraping and is
guaranteed correct.

- **Injection site:** `createSession` in the store is the single choke point all
  agent spawns pass through. When `processStatus === 'claude'` and the
  `initialCommand` is a Claude launch that doesn't already carry `--session-id`
  or `--resume`, insert `--session-id <sessionId>` among the flags — **before**
  any trailing quoted positional prompt (appending after the prompt would break
  Claude's arg parsing). A small pure helper `injectClaudeSessionId(command,
  sessionId)` handles the string surgery and is unit-tested.
- Sessions launched **before** this ships have no injected id. Their history
  entries have no `resumeId`; resurrection falls back to `claude --continue` in
  the still-existing directory (resumes the most recent conversation there —
  almost always the same one).

### Codex — best-effort

The existing `codex-rollout-watcher` already discovers the rollout file
(`rollout-<ts>-<sessionId>.jsonl`) whose filename embeds the codex session uuid.
We surface that uuid back to the renderer/store and store it on the session so it
lands in the history entry's `resumeId`.

- If captured → `codex resume <resumeId> …`.
- If never captured (watcher didn't attach) → restart fresh Codex in the target
  dir. We do **not** guess with `--last`, because `--last` is not cwd-scoped and
  could resume an unrelated session.

### Cursor

No resume path; always restart fresh.

## Resume logic

```ts
resurrectSession(entry: SessionHistoryEntry): void
```

```
pathExists = await window.electronAPI.pathExists(entry.cwd)
target     = pathExists ? entry.cwd : entry.repoRootDir   // "start on main" when gone

command by (agentType, pathExists, resumeId):
  claude, exists,  hasId   → claude --resume <resumeId> --dangerously-skip-permissions [--model m] [--effort e]
  claude, exists,  noId    → claude --continue --dangerously-skip-permissions
  claude, gone             → fresh: claude --dangerously-skip-permissions --session-id <newId> [--model m] [--effort e]
  codex,  exists,  hasId   → codex resume <resumeId> -c model_reasoning_effort="<e|high>" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true
  codex,  (noId OR gone)   → fresh codex (default args) in target
  cursor                   → fresh agent --force --model composer-2-fast in target
```

Resolution of the target tree:

- **Path exists** → find the workspace tree whose `rootDir === entry.cwd` and
  spawn there. If that tree no longer exists (worktree removed but path somehow
  still on disk), fall back to tree 0.
- **Path gone** → tree 0 (main).

Spawning reuses the existing `createSession` flow (which itself injects
`--session-id` for fresh Claude launches). A dedicated
`buildAgentResumeCommand(entry, { pathExists })` helper builds the resume/fresh
command string; it lives alongside `buildActionCommand` in
`shared/action-utils.ts` and is unit-tested.

### New IPC

`pathExists(p: string): Promise<boolean>` — a thin `fs.existsSync` wrapper in the
main process, exposed on `ElectronAPI`. Used to decide resume-in-place vs
start-on-main.

## UI

- **`SessionHistoryButton`** — header button, rendered left of the diff button in
  `App.tsx`. Same visual language as the diff button (`txtColor` tints, rounded,
  `WebkitAppRegion: 'no-drag'`). Icon: a ↺ / history glyph consistent with the
  app's icon set.
- **`SessionHistoryPanel`** — dropdown popover anchored under the button. Scrolls
  when the list is long. Rows: agent icon + label + worktree/branch + relative
  time; path-gone rows carry a "· main" hint. Clicking a row calls
  `resurrectSession` and closes the panel.
- **Empty state:** "No recently closed agents."
- The button may be hidden entirely when the current workspace has zero history
  entries, or shown disabled — decided during implementation to match the diff
  button's conditional-render pattern.

## Edge cases

- Resurrecting keeps the entry in history; re-killing refreshes `killedAt` (via
  dedup-by-id upsert).
- If `repoRootDir` itself no longer exists (whole repo deleted), the row is
  disabled with an explanatory tooltip.
- Retention cap keeps the list bounded; oldest-per-workspace dropped first.
- The `--session-id` injection is guarded so it never double-injects and never
  touches non-Claude or already-resume commands.

## Non-goals

- Web/phone parity — this is a desktop-only feature.
- Cross-workspace history browsing.
- Reviving plain terminal sessions.
- Codex/Cursor resume parity beyond the best-effort path above.

## Behavior-change callouts

1. **`--session-id` is now injected into every new interactive Claude launch**,
   not just resurrected ones. Low-risk, and required for deterministic resume,
   but it touches the normal spawn hot path.
2. **Codex id capture** adds a small daemon/main → renderer plumbing path to
   surface the rollout uuid. If deemed too costly, Codex can fall back to
   always-fresh and this plumbing is dropped without affecting the rest.
