# Web Worktree Creation — Design

**Date:** 2026-06-22
**Status:** Approved

## Goal

Let the Orchestra web remote control create a git worktree on any workspace,
1:1 with the desktop flow. A "**+ New worktree**" row at the bottom of each
workspace group in the web sidebar opens a `WorktreeDialog` — a port of the
desktop dialog (branch name + "Run on creation" action checkboxes + "Spin up"
agent picker). Submitting runs the exact same creation flow the desktop runs
for a local dialog submit, and the web auto-attaches to the spun-up session.

This reuses the existing web-remote command pattern established by the Web
Remote Actions Bar (see `2026-06-22-web-remote-actions-bar-design.md`):
sanitize → Convex `sendCommand` kind → bridge IPC → renderer hook.

## Reference: desktop flow

- **Dialog:** `WorktreeDialog` in `apps/desktop/src/renderer/src/components/Sidebar.tsx`.
  Fields: `branch` (text), `selectedActionIds` (multi-select over the
  workspace's custom actions), `spinUp` (single-select agent:
  `'terminal' | 'claude' | 'codex' | 'cursor'`). Result type
  `WorktreeDialogResult`.
- **Submit handler:** `handleCreateWorktree` (Sidebar.tsx ~1363–1391) calls
  `electronAPI.createWorktree(mainRoot, branch, settings.worktreesDir)` →
  `addWorktree(workspaceId, path)` → runs each selected action
  (`runAction` / `runBackgroundAction`) → `createSession(...)` in the new tree.
- **IPC:** `create-worktree` handler in `apps/desktop/src/main/index.ts` runs
  `git worktree add -b <branch> <targetDir>`, falling back to
  `git worktree add <targetDir> <branch>` when the branch already exists.
- **Data model:** `Workspace.trees[]` (`apps/desktop/src/shared/types.ts`);
  index 0 is the main repo, 1+ are worktrees. A new worktree is appended and
  becomes active.

## Architecture (6 pieces)

### 1. New command kind `createWorktree` (backend)

- `apps/backend/convex/schema.ts`: add `"createWorktree"` to the
  `ptyCommands.kind` union.
- `apps/backend/convex/remote.ts`: add `"createWorktree"` to the
  `sendCommand` `kind` union.
- Payload shape:
  `{ workspaceId: string; branch: string; selectedActionIds: string[]; spinUp: 'terminal' | 'claude' | 'codex' | 'cursor' | null }`.
  `sessionId` is unused for this kind (pass `""`), same convention as
  `runAction`.

### 2. Bridge (`apps/desktop/src/main/remote-bridge.ts`)

`applyOne` gains a `case 'createWorktree'` that forwards to the renderer:

```ts
mainWindow?.webContents.send('remote-create-worktree', {
  workspaceId: String(cmd.payload?.workspaceId ?? ''),
  branch: String(cmd.payload?.branch ?? ''),
  selectedActionIds: Array.isArray(cmd.payload?.selectedActionIds)
    ? cmd.payload.selectedActionIds.map(String)
    : [],
  spinUp: cmd.payload?.spinUp ?? null,
})
```

### 3. Preload (`apps/desktop/src/preload/index.ts`)

Add `onRemoteCreateWorktree(cb)` — a clone of `onRemoteRunAction` (the
`remote-run-action` listener at lines ~159/281/282), listening on the
`remote-create-worktree` channel, with the matching `ElectronAPI` type entry
in `apps/desktop/src/shared/types.ts`.

### 4. Renderer — extract & reuse the creation flow

The body of `handleCreateWorktree` is extracted into a shared function
`runWorktreeCreation(state, workspaceId, { branch, selectedActionIds, spinUp })`
that performs: `electronAPI.createWorktree` → `addWorktree` → run selected
actions → `createSession` in the new tree index. `state` is the app-store
snapshot (`useAppStore.getState()`), giving access to `workspaces`, `settings`,
`addWorktree`, `runAction`, `runBackgroundAction`, and `createSession`.

Two callers:

- The desktop `WorktreeDialog` submit handler (replaces the inline body).
- A new `useRemoteWorktree` hook (sibling of `useRemoteActions` in
  `apps/desktop/src/renderer/src/hooks/`), wired alongside `useRemoteActions`,
  that listens for `remote-create-worktree` and calls `runWorktreeCreation`.

**Error handling:** a failed `git worktree add` already returns
`{ success: false, error }` from the IPC. The desktop dialog path surfaces it
via `window.alert` (unchanged). The remote path no-ops on web — the chosen
fire-and-forget behavior; no result is sent back, so no new backend surface.

### 5. Web dialog + sidebar trigger

- `apps/web/src/components/Sidebar.tsx`: the web `SafeWorkspace` interface gains
  `customActions: { id: string; name: string; icon: string }[]`. This field is
  already produced by `sanitizeWorkspaces` and consumed by `ActionBar` via
  `apps/web/src/lib/actions.ts` — reuse that `SafeAction` type.
- New `apps/web/src/components/WorktreeDialog.tsx`: a 1:1 port —
  - branch text input (required to submit),
  - "Run on creation" checkboxes over `ws.customActions` (rendered with
    `DynamicIcon`), producing `selectedActionIds`,
  - "Spin up on creation" agent buttons, hardcoded
    `['terminal', 'claude', 'codex', 'cursor']` to match the desktop list.
  - On submit:
    `convex.mutation(anyApi.remote.sendCommand, { token, sessionId: '', kind: 'createWorktree', payload: { workspaceId, branch, selectedActionIds, spinUp } })`,
    then `onWorktreeFired()`.
- A "+ New worktree" row rendered at the bottom of each workspace
  `SidebarGroup` opens the dialog for that workspace.

### 6. Auto-attach (`apps/web/src/app/page.tsx`)

The dialog's `onWorktreeFired` opens the same short-lived (~8s) pending-attach
window the ActionBar already uses. The existing effect watching
`remoteState.activeSessionId` switches the web view (`selected`) to the new
session once it appears within that window. The window-gating prevents the
desktop user's own session switches from hijacking the web view.

## Data flow

```
web WorktreeDialog submit
  → convex sendCommand(kind: 'createWorktree', payload)
  → ptyCommands row
  → bridge applyOne → webContents.send('remote-create-worktree', payload)
  → useRemoteWorktree → runWorktreeCreation(state, workspaceId, opts)
      → electronAPI.createWorktree → git worktree add
      → addWorktree + run actions + createSession (spin-up)
  → desktop focuses new session → activeSessionId changes → pushState
  → web (within ~8s window) switches selected to the new session  ✓
```

## Testing

- **Unit (desktop main):** `applyOne` routes a `createWorktree` command to a
  `webContents.send` spy with channel `remote-create-worktree` and the correct
  normalized payload (string `workspaceId`/`branch`, array `selectedActionIds`,
  passthrough `spinUp`).
- **Unit (desktop renderer):** `runWorktreeCreation` calls
  `addWorktree`/selected actions/`createSession` on IPC success, and no-ops
  (no `addWorktree`/`createSession`) when `createWorktree` resolves
  `{ success: false }`.
- **Web:** `WorktreeDialog` renders the branch input, one checkbox per custom
  action, and the four agent buttons; submitting fires `sendCommand` with the
  correct payload and calls `onWorktreeFired`.

## Out of scope

- Removing worktrees from the web.
- Creating/editing custom actions from the web.
- Base-branch selection (the desktop dialog doesn't offer it — `git worktree
  add -b` branches from current HEAD).
