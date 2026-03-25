# Linear Board View

## Overview

Add a "Board" view mode to Orchestra workspaces that integrates with Linear's API to show a kanban board of team tickets. Each workspace can toggle between the existing orchestrator (terminal) view and the new board view.

## Data Model

### Workspace type additions

```ts
interface Workspace {
  // ...existing fields...
  viewMode: 'orchestrator' | 'board'
  linearConfig?: {
    apiKey: string
    teamId: string
    teamName: string
  }
}
```

- `viewMode` defaults to `'orchestrator'` for all existing workspaces
- `linearConfig` is optional — board view shows empty state without it
- View toggle only appears in sidebar when `linearConfig` is set

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

Renderer-only approach — `fetch` calls directly to Linear's GraphQL API (`https://api.linear.app/graphql`). No main process IPC needed for data fetching. API key stored as part of `linearConfig` on the workspace, persisted via electron-store.

### Client

A lightweight `linear-client.ts` utility in `renderer/src/utils/` wrapping raw GraphQL queries. No Linear SDK dependency.

### Key queries

- `teams` — list teams for setup dropdown
- `team.states` — fetch workflow states (kanban columns)
- `team.issues` — fetch issues with: title, description, status, assignee, priority, identifier, labels

### Mutations

- `issueUpdate` — change issue state (for drag-to-change-status)

### React hook: `useLinearBoard`

- Input: `linearConfig` from workspace
- Returns: `{ columns, issues, loading, error, refresh }`
- Polls every 45 seconds when board view is active
- Stops polling when view switches to orchestrator
- Caches last result in zustand for instant switching back

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
- Optimistic UI update — reverts on mutation failure

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
- Arrow up/down to navigate between tickets when panel is open

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
2. App fetches available teams on key entry
3. Dropdown to select team
4. Save persists `linearConfig` on the workspace

## Polling

- Auto-refresh every 45 seconds when board view is active
- Polling stops when switching to orchestrator view or when workspace is not active
- Manual refresh button available in board header

## Technical Notes

- No new npm dependencies for Linear API (raw fetch + GraphQL)
- No new IPC channels needed (renderer-only API calls)
- Drag-and-drop uses native HTML5 DnD API
- Board state cached in zustand for instant view toggling
