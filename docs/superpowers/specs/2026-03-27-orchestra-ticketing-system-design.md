# Orchestra Ticketing System

Replaces the current Linear board view with Orchestra's own Convex-powered issue tracking system. Linear becomes an import source only — no sync back. Issues are workspace-scoped, stored in Convex, and rendered with real-time reactive queries.

## Data Model

### Convex Schema

Two new tables added to `apps/backend/convex/schema.ts`.

**`issues`**

| Field | Type | Notes |
|-------|------|-------|
| `workspaceId` | `string` | Scopes issue to a workspace |
| `title` | `string` | Required |
| `description` | `optional string` | Markdown/plain text |
| `status` | `union: "todo" \| "in_progress" \| "in_review" \| "done"` | Board column |
| `priority` | `number` (0-4) | 0=none, 1=urgent, 2=high, 3=medium, 4=low |
| `assigneeName` | `optional string` | Display name (no user system) |
| `assigneeAvatarUrl` | `optional string` | Avatar URL |
| `labelIds` | `array of Id<"issueLabels">` | References to issueLabels table |
| `linearId` | `optional string` | Linear issue ID for dedup on re-import |
| `linearIdentifier` | `optional string` | e.g. "ENG-123" |
| `linearUrl` | `optional string` | Link back to Linear |
| `identifier` | `string` | Display ID, e.g. "ORQ-1". Auto-incremented per workspace. For imported issues, uses `linearIdentifier` (e.g. "ENG-123") instead. |
| `position` | `number` | Sort order within column |
| `createdAt` | `number` | Epoch ms |
| `updatedAt` | `number` | Epoch ms |

Indexes:
- `by_workspace`: `["workspaceId"]`
- `by_linearId`: `["linearId"]`

**`issueLabels`**

| Field | Type | Notes |
|-------|------|-------|
| `workspaceId` | `string` | Scoped to workspace |
| `name` | `string` | Label text |
| `color` | `string` | Hex color |

Index:
- `by_workspace`: `["workspaceId"]`

## Import System

### Linear Import Config

Extends the existing `linearConfig` in workspace settings (electron-store):

```typescript
linearConfig: {
  apiKey: string          // encrypted via safeStorage (existing)
  teamId: string          // existing
  teamName: string        // existing
  filters: {
    assigneeIds?: string[]  // Linear user IDs
    labelIds?: string[]     // Linear label IDs
    stateIds?: string[]     // Linear workflow state IDs
  }
  importIntervalMinutes: number  // default 30
}
```

### Import Flow

1. Desktop decrypts API key locally, calls Linear GraphQL with server-side `IssueFilter` parameter
2. For each returned issue:
   - If `linearId` exists in Convex → update title, description, priority, assignee, labels. Status is NEVER updated on re-import — once an issue is in Orchestra, the user owns its status.
   - If not → create new issue with status mapped from Linear state type
   - Orchestra-owned fields (`position`, `status`) are never overwritten on re-import
3. Labels: matched by name within workspace, created if missing

### Status Mapping (Linear → Orchestra)

| Linear state type | Orchestra status |
|-------------------|-----------------|
| `backlog` | `todo` |
| `triage` | `todo` |
| `unstarted` | `todo` |
| `started` | `in_progress` |
| `completed` | `done` |
| `cancelled` | Skipped (not imported) |

### Import Triggers

- **Manual**: "Import from Linear" button in board header
- **Periodic**: Background interval (configurable, default 30 min), only runs when desktop app is open

### Filter Setup UI

In Settings dialog, after connecting Linear and selecting a team:
- Multi-select dropdowns for assignee, labels, and workflow status
- Options fetched from Linear API (`fetchTeamMembers`, `fetchTeamLabels`, workflow states from `fetchBoardData`)
- Filters saved to workspace `linearConfig`

## Board UI

Replaces the current `LinearBoard` component entirely.

### Convex Client Setup

- `ConvexProvider` wraps the renderer app
- Board uses `useQuery` / `useMutation` from `convex/react`
- Convex deployment URL from existing `apps/desktop/src/main/convex-config.ts`

### Board Component (`IssueBoard.tsx`)

- Four fixed columns: Todo, In Progress, In Review, Done
- `useQuery(api.issues.listByWorkspace, { workspaceId })` — reactive, auto-updates
- Drag-and-drop between columns with optimistic updates via `useMutation`
- Issue cards show: priority dot, identifier (`linearIdentifier` like "ENG-123" for imported issues, or auto-incremented "ORQ-N" for native issues), title, labels (max 2 + overflow count), assignee avatar
- Click card → detail panel (mirrors current `LinearDetailPanel` pattern)

### Issue Creation

- "+" button on each column or board-level "New Issue" button
- Inline form: title (required), description, priority, labels, assignee
- Writes directly to Convex via mutation

### Board Header

- Workspace name, issue count (reactive — always accurate)
- "Import from Linear" button (visible when Linear is configured), spinner during import, toast with import count on completion
- Last import timestamp

### Real-Time Behavior

- No polling — Convex subscriptions push updates automatically
- Multiple windows see changes instantly
- Optimistic UI on drag-and-drop: column moves immediately, rolls back on mutation failure

## Convex Functions

### `apps/backend/convex/issues.ts`

**Queries:**
- `listByWorkspace({ workspaceId })` — all issues for workspace, sorted by position within each status
- `getById({ id })` — single issue for detail panel

**Mutations:**
- `create({ workspaceId, title, description?, priority?, status, assigneeName?, labelIds?, position })` — new issue
- `update({ id, ...partial fields })` — edit any field
- `updateStatus({ id, status, position })` — drag-and-drop column change
- `remove({ id })` — delete issue
- `upsertFromLinear({ workspaceId, linearId, title, description, priority, assigneeName, assigneeAvatarUrl, labels, linearIdentifier, linearUrl, mappedStatus })` — import upsert; updates non-Orchestra fields if `linearId` exists, creates otherwise

### `apps/backend/convex/issueLabels.ts`

**Queries:**
- `listByWorkspace({ workspaceId })` — all labels for workspace

**Mutations:**
- `create({ workspaceId, name, color })` — new label
- `findOrCreateByName({ workspaceId, name, color })` — used during import

## Files Changed / Created

### New Files
- `apps/backend/convex/issues.ts` — issue queries and mutations
- `apps/backend/convex/issueLabels.ts` — label queries and mutations
- `apps/desktop/src/renderer/src/components/IssueBoard.tsx` — main board component
- `apps/desktop/src/renderer/src/components/IssueCard.tsx` — issue card component
- `apps/desktop/src/renderer/src/components/IssueDetailPanel.tsx` — detail sidebar
- `apps/desktop/src/renderer/src/components/IssueCreateForm.tsx` — inline issue creation
- `apps/desktop/src/renderer/src/utils/linear-importer.ts` — import logic (fetch + upsert)

### Modified Files
- `apps/backend/convex/schema.ts` — add `issues` and `issueLabels` tables
- `apps/desktop/src/shared/types.ts` — extend `linearConfig` with `filters` and `importIntervalMinutes`
- `apps/desktop/src/renderer/src/components/SettingsDialog.tsx` — add filter configuration UI
- `apps/desktop/src/renderer/src/App.tsx` — replace `LinearBoard` with `IssueBoard`, add `ConvexProvider`
- `apps/desktop/src/renderer/src/utils/linear-client.ts` — add `fetchTeamMembers`, `fetchTeamLabels`, add filter param to `fetchBoardData`

### Removed (after migration)
- `apps/desktop/src/renderer/src/components/LinearBoard.tsx`
- `apps/desktop/src/renderer/src/components/LinearTicketCard.tsx`
- `apps/desktop/src/renderer/src/components/LinearDetailPanel.tsx`
- `apps/desktop/src/renderer/src/hooks/useLinearBoard.ts`
- Zustand `linearBoardCache` and `linearMutationInflight` state (replaced by Convex reactivity)
