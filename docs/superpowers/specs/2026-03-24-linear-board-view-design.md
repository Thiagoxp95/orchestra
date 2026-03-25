# Linear Board View

## Overview

Add a "Board" view mode to Orchestra workspaces that integrates with Linear's API to show a kanban board of team tickets. Each workspace can toggle between the existing orchestrator (terminal) view and the new board view.

## Data Model

### Workspace type additions

```ts
interface Workspace {
  // ...existing fields...
  viewMode?: 'orchestrator' | 'board'  // optional, defaults to 'orchestrator'
  linearConfig?: {
    apiKey: string   // encrypted via safeStorage, stored as base64
    teamId: string
    teamName: string
  }
}
```

- `viewMode` is optional — absent or `'orchestrator'` both mean orchestrator view. Existing workspaces need no migration.
- `linearConfig` is optional — board view shows empty state without it
- View toggle only appears in sidebar when `linearConfig` is set

### Store changes

The `updateWorkspace` action must be extended to accept `viewMode` and `linearConfig` in its `Partial<Pick<...>>` type.

Cached board data in zustand is keyed by workspace ID. When a workspace is deleted, its board cache entry is cleaned up in `deleteWorkspace`.

## API Key Security

Linear API keys are personal access tokens with broad access. They are encrypted using Electron's `safeStorage` API before persisting to disk.

### IPC channels (main process)

- `linear:encrypt-key` — accepts raw API key string, returns base64-encoded encrypted blob
- `linear:decrypt-key` — accepts encrypted blob, returns raw API key string

### Flow

1. User pastes API key in workspace settings
2. Renderer calls `linear:encrypt-key` IPC, stores encrypted result in `linearConfig.apiKey`
3. `useLinearBoard` hook calls `linear:decrypt-key` once on mount to get the raw key for API calls
4. Raw key held only in memory, never persisted to disk

## View Mode Toggle

### Placement

Between the workspace emoji/name row and the trees/sessions content in the sidebar. Two icon-only buttons side by side — terminal icon (orchestrator) and Linear-style icon (board). Styled as a compact segmented control (~24px tall) using workspace color theming.

### Behavior

- Active view icon at full opacity, inactive at ~40%
- Clicking switches `viewMode` on the workspace
- Toggle hides when sidebar is collapsed
- Toggle only renders when `linearConfig` is present

### View switching

- **Orchestrator → Board:** Main content area swaps from terminal to kanban board. Sidebar hides sessions/trees for the workspace, shows a compact summary (team name, issue count, last refreshed).
- **Board → Orchestrator:** Terminal area returns, sessions reappear in sidebar.
- Terminal sessions stay alive in background — no PTY teardown on view switch.

## Linear API Integration

### Architecture

Renderer fetches directly to Linear's GraphQL API (`https://api.linear.app/graphql`). API key decrypted via IPC on mount, held in memory only. No CSP is currently in place; if one is added, `connect-src` must include `https://api.linear.app`.

### Client

A lightweight `linear-client.ts` utility in `renderer/src/utils/` wrapping raw GraphQL queries. No Linear SDK dependency.

### Key queries

- `teams` — list teams for setup dropdown
- `team.states` — fetch workflow states (kanban columns)
- `team.issues` — fetch issues with: title, description, status, assignee, priority, identifier, labels

### Mutations

- `issueUpdate` — change issue state (for drag-to-change-status)

### React hook: `useLinearBoard`

- Input: `linearConfig | undefined` — returns empty/idle state when undefined
- Returns: `{ columns, issues, loading, error, refresh }`
- Polls every 45 seconds when board view is active
- Stops polling when view switches to orchestrator or workspace is inactive
- Pauses polling when app window is not focused (`document.visibilityState`)
- Caches last result in zustand for instant switching back
- Cleans up interval on unmount

## Error Handling

### Invalid/revoked API key (401)

Board shows inline error banner: "Linear API key is invalid or expired" with a button to open workspace settings. `linearConfig` is preserved (not cleared) so the user can update the key.

### Network failure

Board shows last cached data with a muted banner: "Last updated X ago — refresh failed." Next poll attempt proceeds normally.

### Rate limiting (429)

On 429, polling interval doubles (up to 5 minutes max). Resets to 45 seconds on next successful fetch. Manual refresh is throttled to once per 10 seconds.

### Team deleted/inaccessible

Board shows error: "Team not found — it may have been deleted in Linear" with a button to reconfigure in workspace settings.

## Kanban Board Component

### Layout

Replaces `TerminalArea` in the main content area when board view is active. Horizontal scroll container with columns.

### Columns

- One column per Linear workflow state
- Sorted by Linear's `position` field (respects team workflow order)
- Header shows: status name + issue count
- Colored indicator matching Linear's state color

### Ticket cards

Each card displays:
- **Identifier** (e.g., `ORC-123`) — muted, small text
- **Title** — primary text, truncated to 2 lines
- **Priority** — small colored dot/icon (urgent/high/medium/low/none)
- **Assignee** — small avatar circle, initials fallback
- **Labels** — small pills, max 2 visible + "+N" overflow

### Drag and drop

- Native HTML drag-and-drop (no library dependency)
- Cards get subtle lift shadow while dragging
- Drop zones highlight on target column
- Fires `issueUpdate` mutation on drop
- Optimistic UI update — on failure, card animates back to original column and a toast shows "Failed to update status"
- If a poll response arrives while a drag mutation is in-flight, the optimistic state takes precedence until the mutation resolves
- If the API key has read-only access (403 on mutation), show toast "No permission to update issues" and revert

### Empty state

When no `linearConfig`: centered prompt "Connect Linear to see your team's board" with button to open workspace settings.

## Ticket Detail Panel

### Slide-in panel

- Appears from right edge of board, ~400px wide
- Subtle border-left, workspace-color-themed background
- Board columns compress/scroll behind it

### Contents

- Identifier + title at top
- Status badge (colored by workflow state)
- Metadata row: priority, assignee, labels
- Description — rendered with preserved whitespace/line breaks (v1), markdown rendering optional
- External link to open in Linear

### Interactions

- Close via X button or Escape key
- Status changeable via dropdown (same states as columns)
- No editing of title/description — stays in Linear
- Arrow up/down to navigate between tickets within the same column when panel is open

## Sidebar Behavior in Board Mode

### Active board view

- Trees, sessions, worktree button, action bar all hide
- Compact summary replaces them: team name, issue count, last refreshed
- Workspace tab area stays clean

### Active orchestrator view

- Everything works exactly as today — no changes

### Collapsed sidebar

- View toggle hides (same behavior as settings icon)
- Workspace emoji still shows, clicking switches workspaces

## Setup Flow

Located in workspace settings dialog, new "Linear" section:

1. Text input to paste Linear API key
2. App encrypts key via `linear:encrypt-key` IPC and validates by fetching teams
3. Dropdown to select team
4. Save persists `linearConfig` on the workspace

### Disconnect flow

A "Disconnect Linear" button in workspace settings:
- Clears `linearConfig` from the workspace
- Resets `viewMode` to `'orchestrator'`
- Clears cached board data from zustand

## Polling

- Auto-refresh every 45 seconds when board view is active
- Polling stops when switching to orchestrator view or when workspace is not active
- Polling pauses when app window loses focus, resumes on focus
- Manual refresh button available in board header (throttled to once per 10 seconds)
- Interval backs off on rate limiting (see Error Handling)

## Technical Notes

- No new npm dependencies for Linear API (raw fetch + GraphQL)
- Two new IPC channels: `linear:encrypt-key` and `linear:decrypt-key` (for safeStorage)
- Drag-and-drop uses native HTML5 DnD API (not keyboard-accessible in v1 — status dropdown in detail panel is the accessible alternative)
- Board state cached in zustand for instant view toggling
- If CSP is added in future, `connect-src` must include `https://api.linear.app`
