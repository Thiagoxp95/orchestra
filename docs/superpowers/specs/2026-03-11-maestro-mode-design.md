# Maestro Mode Design Spec

## Overview

Maestro Mode is a full-screen multi-pane view that displays all active AI agents (Claude/Codex) across all worktrees in the current workspace simultaneously. It provides a monitoring and interaction dashboard for orchestrating multiple agents at once.

## Requirements

- Full-screen overlay showing all active agents in the current workspace
- Only agent sessions included (processStatus === 'claude' or 'codex'), no regular terminals
- Agents from all worktrees/branches within the workspace are shown
- Workspace cycling via existing `Cmd+Left/Right` shortcuts
- Grid cell borders colored with the active workspace's color
- Live interactive terminals — click to focus and type
- Dynamic updates as agents start/stop

## Architecture

### State

New fields in the zustand `useAppStore` store:

- `maestroMode: boolean` — whether Maestro Mode is active
- `maestroFocusedSessionId: string | null` — which pane currently has keyboard focus
- `preMaestroActiveSessionId: string | null` — the activeSessionId before entering Maestro Mode, restored on exit

**Store actions:**
- `toggleMaestroMode()` — when entering, saves current `activeSessionId` to `preMaestroActiveSessionId`. When exiting, restores `activeSessionId` from `preMaestroActiveSessionId`.
- `setMaestroFocusedSession(sessionId)` — sets which pane has focus
- `cycleMaestroFocus(direction: 'next' | 'prev')` — cycles `maestroFocusedSessionId` through the filtered agent session list

**Workspace cycling guard:** When `maestroMode === true`, the `setActiveWorkspace` action must NOT modify `activeSessionId`. It should only update `activeWorkspaceId` and reset `maestroFocusedSessionId` to the first agent in the new workspace.

Agent session list is a **derived selector** (not stored state):

```ts
// Selector: all agent sessions in the active workspace across all worktrees
const agentSessions = useMemo(() => {
  const workspace = workspaces[activeWorkspaceId]
  if (!workspace) return []
  const allSessionIds = workspace.trees.flatMap(tree => tree.sessionIds)
  return allSessionIds
    .map(id => sessions[id])
    .filter(s => s && (s.processStatus === 'claude' || s.processStatus === 'codex'))
}, [workspaces, activeWorkspaceId, sessions])
```

### New Component: MaestroMode

A full-screen overlay component rendered in `App.tsx` when `maestroMode === true`.

**Positioning:** Absolute positioned, covers the main content area (Sidebar + TerminalArea + DiffPanel). Background: `#0e0e1a`.

**Rendering hierarchy (matching actual App.tsx structure):**

```
<App>
  <div flex-col h-screen>
    <div className="dev-grid-border" />
    <div flex-1>
      <div flex-1 pt-3>
        {maestroMode ? (
          <MaestroMode />          <!-- replaces sidebar + terminal area -->
        ) : (
          <>
            <Sidebar />
            <TerminalArea /> or <DiffView />
            <DiffPanel />
          </>
        )}
      </div>
      <div w-3 />
    </div>
    <NavBar />                     <!-- always visible at bottom, shows MAESTRO badge -->
    <ToastContainer />
  </div>
</App>
```

Note: Sidebar is **conditionally rendered** (not hidden), so its keydown handlers do not fire during Maestro Mode. The original `TerminalArea` instances remain mounted but hidden via `visibility: hidden` within a wrapper to preserve xterm state.

**Keybinding ownership:** Since Sidebar is unmounted during Maestro Mode, all keybindings that normally live in Sidebar's `useEffect` handler must be re-implemented in MaestroMode's own keydown handler. This includes workspace cycling (`Cmd+Left/Right`, `Cmd+Shift+1..9`) and custom action keybindings (`Cmd+N`, `Cmd+O`, etc.) so users can spawn new agents without exiting. The `Cmd+Up/Down` and `Ctrl+J/K` shortcuts are repurposed during Maestro Mode to cycle `maestroFocusedSessionId` through the agent pane list rather than the full session list.

### Grid Layout Algorithm

CSS Grid with auto-computed columns:

| Agent Count | Layout |
|---|---|
| 1 | 1x1 (full screen) |
| 2 | 2 columns, 1 row |
| 3 | 3 columns, 1 row |
| 4 | 2 columns, 2 rows |
| 5-6 | 3 columns, 2 rows |
| 7-9 | 3 columns, 3 rows |
| 10+ | 4 columns, rows as needed |

Implementation:

```ts
function getGridColumns(count: number): number {
  if (count <= 1) return 1
  if (count <= 2) return 2
  if (count === 3) return 3
  if (count <= 4) return 2
  if (count <= 9) return 3
  return 4
}
```

Grid uses `grid-template-columns: repeat(cols, 1fr)` and rows auto-fill with `1fr`.

### Terminal Instance Strategy

xterm DOM nodes cannot be moved between containers. Maestro Mode creates **fresh xterm instances** that attach to the same PTY sessions via a dedicated read-only-by-default mechanism.

**New hook: `useMaestroTerminal`**

A variant of the existing `useTerminal` hook with key differences:

1. **Does NOT call `createTerminal`** — avoids triggering `createOrAttach` on the daemon, which would send duplicate snapshots to the original instance
2. **Registers `onTerminalData` listener** — receives live PTY output for display (the main process broadcasts to all listeners for a sessionId)
3. **Guards `terminal-write` behind focus state** — only calls `api.writeTerminal(sessionId, data)` when the pane is the `maestroFocusedSessionId`. When unfocused, the xterm instance is display-only.
4. **Does NOT call `api.resizeTerminal`** — only calls local `fitAddon.fit()` to fit within its grid cell. The original TerminalArea instance retains PTY size authority to avoid resize conflicts.
5. **Requests initial snapshot** via a new IPC call `terminal-snapshot-request` that returns the current terminal buffer state without triggering a full `createOrAttach` cycle. This requires a new `getSnapshot` message type in the daemon protocol — the daemon server reads the session's current buffer and returns it directly. If no snapshot is available (new session with no output), the hook handles a null response gracefully (empty terminal).

**Lifecycle:**
1. When Maestro Mode activates, mount a `MaestroPane` per agent session in its grid cell
2. Each pane uses `useMaestroTerminal` to create a local xterm and subscribe to PTY output
3. Original instances in `TerminalArea` remain mounted but hidden (`visibility: hidden`)
4. On Maestro Mode exit, Maestro panes unmount, originals become visible again

### Keybindings

New built-in shortcuts:

| ID | Default Keybinding | Category | Global | Description |
|---|---|---|---|---|
| `toggle-maestro` | `Cmd+Shift+M` | General | `true` | Toggle Maestro Mode on/off |

Using `Cmd+Shift+M` (M for Maestro) to avoid conflicting with the common `Cmd+Shift+T` "reopen closed tab" convention.

Existing shortcuts that work within Maestro Mode:
- `Cmd+Left/Right` (`cycle-workspaces-left/right`) — cycles workspaces, view recomputes with new workspace's agents

**Maestro-specific focus cycling:** When `maestroMode === true`, the following shortcuts cycle `maestroFocusedSessionId` through the filtered agent session list (NOT the full session list):
- `Cmd+Up/Down` — cycle focus to previous/next pane
- `Ctrl+J/K` — same (vim-style)

These are handled by the `MaestroMode` component's own keydown handler, which takes precedence because Sidebar is unmounted.

Additional in-mode behavior:
- `Escape` — exit Maestro Mode (restores previous activeSessionId). The Escape handler checks that no dialogs are open before acting (via a store flag or DOM check for modal overlays).
- Click a pane to focus it

### Visual Design

**Grid cells:**
- 2px solid border using the active workspace's color
- `gap: 2px` between cells
- Focused cell: border brightens (lighter shade of workspace color) or thickens to 3px

**Pane badge (top-left of each cell):**
- Agent type icon (Claude/Codex indicator)
- Session label text
- Work state indicator: spinning icon if working, checkmark if idle, attention icon if `sessionNeedsUserInput`
- Semi-transparent background (`rgba` of workspace color at ~0.7 opacity)
- Text color from existing `textColor()` utility

**Empty state:**
- Centered "No active agents" text
- Muted workspace color styling
- Displayed when workspace has zero agent sessions

**NavBar indicator:**
- Small "MAESTRO" badge in NavBar when mode is active
- Styled with workspace color

### Dynamic Behavior

- Agents starting while in Maestro Mode: grid recomputes, new pane appears
- Agents stopping while in Maestro Mode: pane removed, grid recomputes
- If the focused agent stops, focus moves to the next available pane
- If all agents stop, show empty state
- Workspace switch via `Cmd+Left/Right`: entire view recomputes for new workspace, `maestroFocusedSessionId` resets to first agent

### Edge Cases

- **No agents in workspace:** Show empty state, mode still activatable
- **Single agent:** Full-screen single pane (essentially normal view but with Maestro chrome)
- **Agent starts/stops during mode:** Grid dynamically adds/removes panes
- **Focused agent exits:** Auto-focus next pane, or empty state if none left
- **Entering Maestro Mode:** Auto-focus first agent pane, save current activeSessionId
- **Escape with dialog open:** Escape closes dialog first, does not exit Maestro Mode
- **Agent watcher lifecycle:** No changes needed — claude/codex watchers are managed at App level by `useProcessStatus` and `useAgentResponses` hooks, independent of terminal rendering
- **`Cmd+W` during Maestro Mode:** Should close `maestroFocusedSessionId` (not `activeSessionId`). The `close-active-session` IPC handler in main process needs a maestro-aware guard, or the renderer intercepts and redirects to the focused pane's session.
- **State persistence:** `maestroMode` should NOT be persisted — always reset to `false` on app restart. `maestroFocusedSessionId` and `preMaestroActiveSessionId` are also transient.
- **xterm font scaling:** Maestro panes may use a smaller font size when grid count exceeds 4 to improve readability in smaller cells (e.g., 12px instead of 14px).

## Files to Create/Modify

### New Files
- `apps/desktop/src/renderer/src/components/MaestroMode.tsx` — Main overlay component with grid layout and keydown handler
- `apps/desktop/src/renderer/src/components/MaestroPane.tsx` — Individual pane wrapper (badge, border, focus handling)
- `apps/desktop/src/renderer/src/hooks/useMaestroTerminal.ts` — Read-only-by-default xterm hook (no createTerminal, no resizeTerminal, focus-gated writes)

### Modified Files
- `apps/desktop/src/renderer/src/store/app-store.ts` — Add `maestroMode`, `maestroFocusedSessionId`, `preMaestroActiveSessionId`, toggle/focus actions, guard `setActiveWorkspace` for maestro mode
- `apps/desktop/src/renderer/src/components/App.tsx` — Conditionally render MaestroMode vs Sidebar+TerminalArea
- `apps/desktop/src/renderer/src/components/NavBar.tsx` — Show MAESTRO badge when active
- `apps/desktop/src/renderer/src/keybindings.ts` — Add `toggle-maestro` to BUILTIN_SHORTCUTS with `global: true`
- `apps/desktop/src/main/index.ts` — Add `terminal-snapshot-request` IPC handler that returns current buffer state without full createOrAttach
- `apps/desktop/src/main/daemon-client.ts` — Add `getSnapshot(sessionId)` method to daemon client
- `apps/desktop/src/daemon/` — Add `getSnapshot` message type to daemon protocol and server implementation
- `apps/desktop/src/preload/index.ts` — Expose `requestTerminalSnapshot` method
- `apps/desktop/src/renderer/src/env.d.ts` — Add type for `requestTerminalSnapshot`
