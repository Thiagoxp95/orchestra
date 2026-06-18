# Design: Bulk Worktree Cleanup + Auto `/remote-control` on New Claude Sessions

Date: 2026-06-18
Status: Approved (pending spec review)

## Overview

Two independent features for the Orchestra desktop app (`apps/desktop`):

1. **Bulk worktree cleanup** — a button in the workspace header (left of the
   settings gear) that removes every non-main worktree whose work is "done":
   its Linear ticket is in Staging/Production, **or** its PR is closed/merged.
2. **Auto `/remote-control`** — every newly launched *blank interactive* Claude
   session (Cmd+N and the NavBar "new Claude" buttons) auto-runs the
   `/remote-control` slash command on startup.

The two features share no code and can be built/reviewed independently.

---

## Feature 1: Bulk Worktree Cleanup

### Trigger / placement

A new icon button in the workspace header row, immediately **left of** the
settings gear, rendered only for the **active** workspace (same condition as the
gear at `Sidebar.tsx:1658`, `isActiveWs`). Icon: a broom/sweep icon from
`hugeicons-react` (final choice during implementation, e.g. `CleanIcon` /
`Brush01Icon`), `size={14}`, same opacity/hover treatment as the gear. Tooltip
`title="Clean up finished worktrees"`. `onClick` calls
`e.stopPropagation()` then `handleCleanupWorktrees(ws.id)`.

### Eligibility

For the active workspace, iterate `ws.trees`. A tree is eligible iff **all** of:

- `treeIndex !== 0` (index 0 is the main repo — never removed).
- It is "done" by **either**:
  - **Linear**: `treeLinearIssues[ws.id][treeIndex]?.state.name`, lowercased and
    trimmed, equals `"staging"` or `"production"`. (Linear workflow-state names
    are workspace-defined; exact case-insensitive match on the state `name`.)
  - **PR**: `treePRs[ws.id][treeIndex]?.state` is `"CLOSED"` or `"MERGED"`.
    (`get-git-pr-info` returns `OPEN | CLOSED | MERGED | DRAFT`.)

Trees with no Linear issue *and* no PR (or with PR `OPEN`/`DRAFT` and Linear not
staging/prod) are left untouched. Eligibility is read from the existing polled
state maps (`treePRs`, `treeLinearIssues`) — no new polling.

> Decision: criteria is **Linear staging/prod OR PR closed/merged** (either
> condition suffices), per product owner.

### Cleanup behavior (per eligible worktree)

No confirmation dialog — clicking the button acts immediately. For each eligible
tree:

1. **Run destruction actions.** For every
   `ws.customActions.filter(a => a.runOnWorktreeDestruction)`, run
   `window.electronAPI.runBackgroundCommand(tree.rootDir, action.command)`.
   - On failure (`!result.success`): show a toast
     (`"<action name/command> failed"`) and **proceed anyway** — do **not**
     abort this worktree or the batch. (Differs from single-delete
     `handleDeleteWorktree`, which prompts and stops.)
2. **Kill sessions.** `for (const sid of tree.sessionIds) killTerminal(sid)`.
3. **Remove the git worktree.**
   `removeWorktree(ws.trees[0].rootDir, tree.rootDir)` (the IPC already forces
   removal: `git worktree remove --force` → `rm -rf` fallback). Ignore the
   result — proceed regardless (force-delete-anyway).
4. **Remove from store.** `removeWorktree(wsId, treeIndex)` (the store action).

### Index-shift handling (critical)

The store's `removeWorktree(wsId, treeIndex)` splices the tree out of the array,
re-indexing later trees, and the polled maps are index-keyed. To avoid deleting
the wrong tree:

- Compute the eligible set as a snapshot of `{ treeIndex, tree }` first.
- Process **sequentially, in descending `treeIndex` order**, `await`-ing each
  worktree's teardown before the next. Deleting from the highest index down
  keeps every lower index stable.

### State / set busy

Reuse the existing `deletingWorktrees` set (`setDeletingWorktree(key, bool)`,
`key = ${wsId}:${treeIndex}`) so cleaned worktrees show the same in-progress
state and the per-row delete is debounced. Guard re-entrancy on the button
(ignore clicks while a cleanup for this workspace is in flight).

### Toasts

There is no global toast store. Reuse the existing local toast pattern in
`Sidebar.tsx` (`actionToasts` state + the render block at ~`2526`). Add a small
generalized `cleanupToasts: { id: string; message: string }[]` local state with
a `showCleanupToast(message)` helper (mirrors `showActionToast`, ~3s auto-fade),
rendered alongside the action toasts. Used for:

- Each destruction-action failure (one toast per failure).
- A summary/empty case: if no eligible worktrees, show
  `"No finished worktrees to clean up"`.

### Files touched

- `renderer/src/components/Sidebar.tsx` — new button in the workspace header
  (~1658), `handleCleanupWorktrees`, `cleanupToasts` state + helper + render,
  an `isEligibleForCleanup(ws, idx)` helper using `treePRs` / `treeLinearIssues`.

No main-process / IPC / store-signature changes (all needed IPCs and the
`removeWorktree` store action already exist).

---

## Feature 2: Auto `/remote-control` on new Claude sessions

### Goal

Every newly launched **blank interactive** Claude session auto-runs the
`/remote-control` slash command at startup, so new instances are immediately
remote-controllable (tied to the in-progress `apps/mobile` remote).

### Scope boundary (the one judgment call)

"All new interactive Claude sessions" in practice means **user-launched Claude
custom actions** — Cmd+N is one such action; the NavBar new-Claude buttons are
others. All of these flow through `buildActionCommand` in
`shared/action-utils.ts`.

Injection applies **only** when the Claude action is a *blank interactive
instance*: `actionType === 'claude'` **and** `!action.printMode` **and**
`!action.command?.trim()`. Rationale: Claude's CLI takes a **single** positional
prompt — you cannot pass both `/remote-control` and a user task prompt as one
arg. Claude actions that already carry a task prompt (and task-specific claude
launches such as DiffView code-review) are **not** "new instances" and are left
unchanged.

### Mechanism

In `buildActionCommand`, in the `actionType === 'claude'` branch, when the
action is a blank interactive instance (above), append the `/remote-control`
slash command as the positional prompt:

```
claude --dangerously-skip-permissions '/remote-control'
```

Claude Code executes a slash command supplied as the initial positional prompt,
then remains interactive. Implement via the existing `parts` array:
when `!action.command?.trim()` and not print mode, `parts.push(shellQuote('/remote-control'))`
(instead of the existing `if (action.command) parts.push(shellQuote(action.command))`).

Define the command string as a shared constant (e.g.
`CLAUDE_REMOTE_CONTROL_COMMAND = '/remote-control'`) in `action-utils.ts` for a
single source of truth.

### Known side effects (acceptable, documented)

- **Agent-run tracking:** `shouldAutoStartAgentRun` (app-store) excludes only the
  *bare* `CLAUDE_INTERACTIVE_COMMAND_PREVIEW`. With the positional appended the
  command no longer matches, so the session registers as an agent launch
  (`agentLaunches`) and may briefly show "working". Harmless — it *is* a Claude
  run. No change required.
- **Warm-agent pool:** `getWarmAgentKindForCommand` matches only the exact bare
  string, so an injected positional simply bypasses warm reuse. The pool is
  experimental and env-gated (`ORCHESTRA_EXPERIMENTAL_WARM_AGENTS`, off by
  default). No breakage; at most a missed prewarm when both are enabled.
- **Command preview:** the action's displayed command in the terminal now shows
  the `'/remote-control'` suffix — expected and informative.

### Files touched

- `shared/action-utils.ts` — `CLAUDE_REMOTE_CONTROL_COMMAND` constant + the
  blank-interactive branch in `buildActionCommand`.

### Tests

`shared/action-utils` has existing coverage. Add cases:

- Blank interactive claude action → command ends with `'/remote-control'`.
- Claude action with a `command` → unchanged (no injection, user prompt wins).
- Print-mode claude action → unchanged.
- Codex / cursor / cli actions → unchanged.

---

## Out of scope / YAGNI

- No setting/toggle for the `/remote-control` behavior (always-on for blank
  interactive Claude sessions).
- No confirmation dialog for bulk cleanup (immediate, per decision).
- No new polling — cleanup reads existing `treePRs` / `treeLinearIssues`.
- No change to single-worktree delete behavior.

## Verification

- **Feature 1:** Create worktrees with (a) a closed/merged PR, (b) a Linear
  ticket in Staging/Production, (c) an open PR + non-staging Linear (control).
  Click the broom → (a) and (b) are removed (including dirty ones), (c) remains.
  Confirm a destruction-action failure toasts but does not block. Confirm
  descending-index deletion removes the correct trees.
- **Feature 2:** Cmd+N a new Claude instance → terminal shows
  `claude --dangerously-skip-permissions '/remote-control'` and Claude runs the
  command on startup. A prompted claude action still launches with its prompt.
