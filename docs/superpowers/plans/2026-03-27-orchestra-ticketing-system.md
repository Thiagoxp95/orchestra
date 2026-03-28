# Orchestra Ticketing System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Linear board view with Orchestra's own Convex-powered issue tracking system, with Linear as an import source.

**Architecture:** Convex stores issues and labels. The renderer connects directly to Convex via `ConvexReactClient` + `ConvexProvider` for real-time reactive queries. Linear import runs on the desktop side (decrypts API key locally, fetches from Linear GraphQL with filters, upserts into Convex). The existing Linear board components are replaced.

**Tech Stack:** Convex (schema, queries, mutations), React 19, Zustand, xterm.js theming, Linear GraphQL API

---

## File Structure

### New Files (Backend)
- `apps/backend/convex/issues.ts` — Issue queries and mutations (listByWorkspace, create, update, updateStatus, remove, upsertFromLinear, getNextIdentifier)
- `apps/backend/convex/issueLabels.ts` — Label queries and mutations (listByWorkspace, create, findOrCreateByName)

### New Files (Renderer)
- `apps/desktop/src/renderer/src/components/IssueBoard.tsx` — Main board with 4 fixed columns, drag-and-drop, import button
- `apps/desktop/src/renderer/src/components/IssueCard.tsx` — Issue card in kanban column
- `apps/desktop/src/renderer/src/components/IssueDetailPanel.tsx` — Right sidebar detail panel
- `apps/desktop/src/renderer/src/components/IssueCreateForm.tsx` — Inline issue creation form
- `apps/desktop/src/renderer/src/utils/linear-importer.ts` — Fetch from Linear with filters, upsert into Convex

### Modified Files
- `apps/backend/convex/schema.ts` — Add `issues` and `issueLabels` tables
- `apps/desktop/.env` — Add `RENDERER_VITE_CONVEX_URL`
- `apps/desktop/.env.development` — Add `RENDERER_VITE_CONVEX_URL`
- `apps/desktop/src/renderer/src/main.tsx` — Wrap App in `ConvexProvider`
- `apps/desktop/src/renderer/src/App.tsx` — Replace `LinearBoard` with `IssueBoard`
- `apps/desktop/src/shared/types.ts` — Extend `linearConfig` with `filters` and `importIntervalMinutes`
- `apps/desktop/src/renderer/src/components/SettingsDialog.tsx` — Add filter dropdowns to Linear settings page
- `apps/desktop/src/renderer/src/utils/linear-client.ts` — Add `fetchTeamMembers`, `fetchTeamLabels`, add filter param to `fetchBoardData`

### Removed Files (after migration complete)
- `apps/desktop/src/renderer/src/components/LinearBoard.tsx`
- `apps/desktop/src/renderer/src/components/LinearTicketCard.tsx`
- `apps/desktop/src/renderer/src/components/LinearDetailPanel.tsx`
- `apps/desktop/src/renderer/src/hooks/useLinearBoard.ts`

---

### Task 1: Convex Schema — issues and issueLabels tables

**Files:**
- Modify: `apps/backend/convex/schema.ts`

- [ ] **Step 1: Add issues and issueLabels tables to schema**

In `apps/backend/convex/schema.ts`, add the two new tables alongside the existing `webhooks` and `webhookEvents`:

```typescript
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // ── Existing tables (unchanged) ────────────────────────────────────
  webhooks: defineTable({
    token: v.string(),
    workspaceId: v.string(),
    actionId: v.string(),
    name: v.string(),
    enabled: v.boolean(),
    filter: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_token", ["token"]),

  webhookEvents: defineTable({
    webhookId: v.id("webhooks"),
    token: v.string(),
    workspaceId: v.string(),
    actionId: v.string(),
    payload: v.any(),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("expired"),
      v.literal("filtered"),
    ),
    filterResult: v.optional(v.string()),
    filterPrompt: v.optional(v.string()),
    createdAt: v.number(),
    processedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_created", ["createdAt"]),

  // ── Ticketing system ───────────────────────────────────────────────
  issues: defineTable({
    workspaceId: v.string(),
    identifier: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    status: v.union(
      v.literal("todo"),
      v.literal("in_progress"),
      v.literal("in_review"),
      v.literal("done"),
    ),
    priority: v.number(), // 0=none, 1=urgent, 2=high, 3=medium, 4=low
    assigneeName: v.optional(v.string()),
    assigneeAvatarUrl: v.optional(v.string()),
    labelIds: v.array(v.id("issueLabels")),
    linearId: v.optional(v.string()),
    linearIdentifier: v.optional(v.string()),
    linearUrl: v.optional(v.string()),
    position: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_linearId", ["linearId"]),

  issueLabels: defineTable({
    workspaceId: v.string(),
    name: v.string(),
    color: v.string(),
  }).index("by_workspace", ["workspaceId"]),
});
```

- [ ] **Step 2: Push schema to Convex**

Run from `apps/backend/`:
```bash
npx convex dev --once
```
Expected: Schema pushes successfully, `_generated/api.d.ts` updates.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/convex/schema.ts apps/backend/convex/_generated/
git commit -m "feat: add issues and issueLabels tables to Convex schema"
```

---

### Task 2: Convex Functions — issueLabels queries and mutations

**Files:**
- Create: `apps/backend/convex/issueLabels.ts`

- [ ] **Step 1: Create issueLabels.ts with all queries and mutations**

```typescript
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const listByWorkspace = query({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) => {
    return await ctx.db
      .query("issueLabels")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
  },
});

export const create = mutation({
  args: {
    workspaceId: v.string(),
    name: v.string(),
    color: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("issueLabels", args);
  },
});

export const findOrCreateByName = mutation({
  args: {
    workspaceId: v.string(),
    name: v.string(),
    color: v.string(),
  },
  handler: async (ctx, { workspaceId, name, color }) => {
    const existing = await ctx.db
      .query("issueLabels")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .filter((q) => q.eq(q.field("name"), name))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("issueLabels", { workspaceId, name, color });
  },
});
```

- [ ] **Step 2: Push and verify**

```bash
cd apps/backend && npx convex dev --once
```
Expected: Deploys successfully, `issueLabels` module appears in `_generated/api.d.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/convex/issueLabels.ts apps/backend/convex/_generated/
git commit -m "feat: add issueLabels Convex queries and mutations"
```

---

### Task 3: Convex Functions — issues queries and mutations

**Files:**
- Create: `apps/backend/convex/issues.ts`

- [ ] **Step 1: Create issues.ts with all queries and mutations**

```typescript
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const listByWorkspace = query({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) => {
    return await ctx.db
      .query("issues")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
  },
});

export const getById = query({
  args: { id: v.id("issues") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

export const create = mutation({
  args: {
    workspaceId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    status: v.union(
      v.literal("todo"),
      v.literal("in_progress"),
      v.literal("in_review"),
      v.literal("done"),
    ),
    priority: v.number(),
    assigneeName: v.optional(v.string()),
    labelIds: v.array(v.id("issueLabels")),
    position: v.number(),
  },
  handler: async (ctx, args) => {
    // Auto-generate identifier: ORQ-N (workspace-scoped counter)
    const existing = await ctx.db
      .query("issues")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    const maxNum = existing.reduce((max, issue) => {
      const match = issue.identifier.match(/^ORQ-(\d+)$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);

    const now = Date.now();
    return await ctx.db.insert("issues", {
      ...args,
      identifier: `ORQ-${maxNum + 1}`,
      assigneeAvatarUrl: undefined,
      labelIds: args.labelIds,
      linearId: undefined,
      linearIdentifier: undefined,
      linearUrl: undefined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("issues"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(
      v.union(
        v.literal("todo"),
        v.literal("in_progress"),
        v.literal("in_review"),
        v.literal("done"),
      ),
    ),
    priority: v.optional(v.number()),
    assigneeName: v.optional(v.string()),
    assigneeAvatarUrl: v.optional(v.string()),
    labelIds: v.optional(v.array(v.id("issueLabels"))),
    position: v.optional(v.number()),
  },
  handler: async (ctx, { id, ...fields }) => {
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) patch[key] = value;
    }
    await ctx.db.patch(id, patch);
  },
});

export const updateStatus = mutation({
  args: {
    id: v.id("issues"),
    status: v.union(
      v.literal("todo"),
      v.literal("in_progress"),
      v.literal("in_review"),
      v.literal("done"),
    ),
    position: v.number(),
  },
  handler: async (ctx, { id, status, position }) => {
    await ctx.db.patch(id, { status, position, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { id: v.id("issues") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});

export const upsertFromLinear = mutation({
  args: {
    workspaceId: v.string(),
    linearId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    priority: v.number(),
    assigneeName: v.optional(v.string()),
    assigneeAvatarUrl: v.optional(v.string()),
    labelIds: v.array(v.id("issueLabels")),
    linearIdentifier: v.string(),
    linearUrl: v.string(),
    mappedStatus: v.union(
      v.literal("todo"),
      v.literal("in_progress"),
      v.literal("in_review"),
      v.literal("done"),
    ),
  },
  handler: async (ctx, { mappedStatus, ...args }) => {
    const existing = await ctx.db
      .query("issues")
      .withIndex("by_linearId", (q) => q.eq("linearId", args.linearId))
      .first();

    const now = Date.now();

    if (existing) {
      // Update non-Orchestra fields only. Status and position are user-owned.
      await ctx.db.patch(existing._id, {
        title: args.title,
        description: args.description,
        priority: args.priority,
        assigneeName: args.assigneeName,
        assigneeAvatarUrl: args.assigneeAvatarUrl,
        labelIds: args.labelIds,
        linearIdentifier: args.linearIdentifier,
        linearUrl: args.linearUrl,
        updatedAt: now,
      });
      return { id: existing._id, created: false };
    }

    // New issue — compute position (append to end of target column)
    const columnIssues = await ctx.db
      .query("issues")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .filter((q) => q.eq(q.field("status"), mappedStatus))
      .collect();
    const maxPosition = columnIssues.reduce((max, i) => Math.max(max, i.position), 0);

    // Generate identifier from linearIdentifier
    const id = await ctx.db.insert("issues", {
      ...args,
      identifier: args.linearIdentifier,
      status: mappedStatus,
      position: maxPosition + 1,
      createdAt: now,
      updatedAt: now,
    });
    return { id, created: true };
  },
});
```

- [ ] **Step 2: Push and verify**

```bash
cd apps/backend && npx convex dev --once
```
Expected: Deploys successfully, `issues` module appears in `_generated/api.d.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/convex/issues.ts apps/backend/convex/_generated/
git commit -m "feat: add issues Convex queries and mutations"
```

---

### Task 4: Renderer Convex Provider Setup

**Files:**
- Modify: `apps/desktop/.env`
- Modify: `apps/desktop/.env.development`
- Modify: `apps/desktop/src/renderer/src/main.tsx`

- [ ] **Step 1: Add renderer-accessible Convex URL to env files**

In `apps/desktop/.env`, add:
```
RENDERER_VITE_CONVEX_URL=https://reminiscent-malamute-957.convex.cloud
```

In `apps/desktop/.env.development`, add the same:
```
RENDERER_VITE_CONVEX_URL=https://reminiscent-malamute-957.convex.cloud
```

The `RENDERER_VITE_` prefix exposes the var to the renderer process in electron-vite.

- [ ] **Step 2: Wrap App in ConvexProvider in main.tsx**

Replace the entire contents of `apps/desktop/src/renderer/src/main.tsx`:

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import { App } from './App'
import './index.css'

const convex = new ConvexReactClient(import.meta.env.RENDERER_VITE_CONVEX_URL)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </React.StrictMode>
)
```

- [ ] **Step 3: Verify the app still builds**

```bash
cd apps/desktop && bun run build
```
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/.env apps/desktop/.env.development apps/desktop/src/renderer/src/main.tsx
git commit -m "feat: add ConvexProvider to renderer for real-time issue board"
```

---

### Task 5: Linear Client — add filter support and team data fetchers

**Files:**
- Modify: `apps/desktop/src/renderer/src/utils/linear-client.ts`
- Modify: `apps/desktop/src/shared/types.ts`

- [ ] **Step 1: Extend Workspace type with filter config**

In `apps/desktop/src/shared/types.ts`, update the `linearConfig` type inside `Workspace`:

```typescript
  linearConfig?: {
    apiKey: string   // encrypted via safeStorage, stored as base64
    teamId: string
    teamName: string
    filters?: {
      assigneeIds?: string[]
      labelIds?: string[]
      stateIds?: string[]
    }
    importIntervalMinutes?: number // default 30
  }
```

- [ ] **Step 2: Add fetchTeamMembers, fetchTeamLabels, and filter support to linear-client.ts**

Add these functions to `apps/desktop/src/renderer/src/utils/linear-client.ts`:

After the existing `fetchTeams` function, add:

```typescript
export async function fetchTeamMembers(apiKey: string, teamId: string): Promise<{ id: string; name: string; displayName: string; avatarUrl: string | null }[]> {
  const data = await linearQuery<{
    team: { members: { nodes: { id: string; name: string; displayName: string; avatarUrl: string | null }[] } }
  }>(apiKey, `
    query($teamId: String!) {
      team(id: $teamId) {
        members {
          nodes {
            id
            name
            displayName
            avatarUrl
          }
        }
      }
    }
  `, { teamId })
  return data.team.members.nodes
}

export async function fetchTeamLabels(apiKey: string, teamId: string): Promise<{ id: string; name: string; color: string }[]> {
  const data = await linearQuery<{
    team: { labels: { nodes: { id: string; name: string; color: string }[] } }
  }>(apiKey, `
    query($teamId: String!) {
      team(id: $teamId) {
        labels {
          nodes {
            id
            name
            color
          }
        }
      }
    }
  `, { teamId })
  return data.team.labels.nodes
}
```

Then modify the existing `fetchBoardData` signature to accept optional filters:

Change:
```typescript
export async function fetchBoardData(apiKey: string, teamId: string): Promise<LinearBoardData> {
```

To:
```typescript
export async function fetchBoardData(
  apiKey: string,
  teamId: string,
  filters?: { assigneeIds?: string[]; labelIds?: string[]; stateIds?: string[] },
): Promise<LinearBoardData> {
```

And update the GraphQL query inside `fetchBoardData` to use the filter:

```typescript
  const issueFilter: Record<string, unknown> = {}
  if (filters?.assigneeIds?.length) {
    issueFilter.assignee = { id: { in: filters.assigneeIds } }
  }
  if (filters?.labelIds?.length) {
    issueFilter.labels = { some: { id: { in: filters.labelIds } } }
  }
  if (filters?.stateIds?.length) {
    issueFilter.state = { id: { in: filters.stateIds } }
  }
  const filterVar = Object.keys(issueFilter).length ? issueFilter : undefined

  const data = await linearQuery<{
    team: {
      name: string
      states: { nodes: LinearWorkflowState[] }
      issues: { nodes: LinearIssue[] }
    }
  }>(apiKey, `
    query($teamId: String!, $filter: IssueFilter) {
      team(id: $teamId) {
        name
        states {
          nodes {
            id
            name
            color
            position
            type
          }
        }
        issues(first: 200, filter: $filter) {
          nodes {
            id
            identifier
            title
            description
            priority
            priorityLabel
            url
            state {
              id
              name
              color
              position
              type
            }
            assignee {
              id
              name
              displayName
              avatarUrl
            }
            labels {
              nodes {
                id
                name
                color
              }
            }
            createdAt
            updatedAt
          }
        }
      }
    }
  `, { teamId, filter: filterVar })
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/shared/types.ts apps/desktop/src/renderer/src/utils/linear-client.ts
git commit -m "feat: add Linear filter support and team data fetchers"
```

---

### Task 6: Linear Importer — fetch from Linear, upsert into Convex

**Files:**
- Create: `apps/desktop/src/renderer/src/utils/linear-importer.ts`

- [ ] **Step 1: Create the importer module**

```typescript
import { ConvexReactClient } from 'convex/react'
import { api } from '../../../../backend/convex/_generated/api'
import { fetchBoardData } from './linear-client'
import type { LinearIssue } from '../../../shared/linear-types'

type IssueStatus = 'todo' | 'in_progress' | 'in_review' | 'done'

function mapLinearStatus(stateType: string): IssueStatus | null {
  switch (stateType) {
    case 'backlog':
    case 'unstarted':
    case 'triage':
      return 'todo'
    case 'started':
      return 'in_progress'
    case 'completed':
      return 'done'
    case 'cancelled':
      return null // skip
    default:
      return 'todo'
  }
}

export interface ImportResult {
  created: number
  updated: number
  skipped: number
}

export async function importFromLinear(
  convex: ConvexReactClient,
  workspaceId: string,
  apiKey: string,
  teamId: string,
  filters?: { assigneeIds?: string[]; labelIds?: string[]; stateIds?: string[] },
): Promise<ImportResult> {
  const boardData = await fetchBoardData(apiKey, teamId, filters)
  let created = 0
  let updated = 0
  let skipped = 0

  for (const issue of boardData.issues) {
    const mappedStatus = mapLinearStatus(issue.state.type)
    if (!mappedStatus) {
      skipped++
      continue
    }

    // Resolve labels: find-or-create each by name in this workspace
    const labelIds = await Promise.all(
      issue.labels.nodes.map((label) =>
        convex.mutation(api.issueLabels.findOrCreateByName, {
          workspaceId,
          name: label.name,
          color: label.color,
        })
      )
    )

    const result = await convex.mutation(api.issues.upsertFromLinear, {
      workspaceId,
      linearId: issue.id,
      title: issue.title,
      description: issue.description ?? undefined,
      priority: issue.priority,
      assigneeName: issue.assignee?.displayName ?? undefined,
      assigneeAvatarUrl: issue.assignee?.avatarUrl ?? undefined,
      labelIds,
      linearIdentifier: issue.identifier,
      linearUrl: issue.url,
      mappedStatus,
    })

    if (result.created) created++
    else updated++
  }

  return { created, updated, skipped }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/utils/linear-importer.ts
git commit -m "feat: add Linear-to-Convex importer with status mapping and dedup"
```

---

### Task 7: IssueCard Component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/IssueCard.tsx`

- [ ] **Step 1: Create the issue card component**

This mirrors the existing `LinearTicketCard` styling but works with Convex issue data.

```tsx
import type { Doc, Id } from '../../../../backend/convex/_generated/dataModel'

const PRIORITY_COLORS: Record<number, string> = {
  0: '#8b8b8b',
  1: '#f76a6a',
  2: '#f59e0b',
  3: '#3b82f6',
  4: '#6b7280',
}

const PRIORITY_LABELS: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
}

interface IssueCardProps {
  issue: Doc<'issues'>
  labels: Doc<'issueLabels'>[]
  txtColor: string
  isLight: boolean
  onClick: () => void
  onDragStart: (e: React.DragEvent) => void
}

export function IssueCard({ issue, labels, txtColor, isLight, onClick, onDragStart }: IssueCardProps) {
  const bg = isLight ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.06)'
  const hoverBg = isLight ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.1)'
  const issueLabels = labels.filter((l) => issue.labelIds.includes(l._id))
  const visibleLabels = issueLabels.slice(0, 2)
  const overflowCount = issueLabels.length - 2

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      className="rounded-lg px-3 py-2.5 cursor-pointer transition-colors group"
      style={{ backgroundColor: bg, color: txtColor }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = hoverBg }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = bg }}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: PRIORITY_COLORS[issue.priority] ?? PRIORITY_COLORS[0] }}
          title={PRIORITY_LABELS[issue.priority] ?? 'No priority'}
        />
        <span className="text-[10px] font-mono opacity-50">{issue.identifier}</span>
      </div>
      <div className="text-sm leading-5 line-clamp-2">{issue.title}</div>
      <div className="flex items-center justify-between mt-2 gap-2">
        <div className="flex items-center gap-1 min-w-0 overflow-hidden">
          {visibleLabels.map((label) => (
            <span
              key={label._id}
              className="text-[10px] px-1.5 py-0.5 rounded-full truncate max-w-[80px]"
              style={{
                backgroundColor: `${label.color}22`,
                color: label.color,
                border: `1px solid ${label.color}44`,
              }}
            >
              {label.name}
            </span>
          ))}
          {overflowCount > 0 && (
            <span className="text-[10px] opacity-40">+{overflowCount}</span>
          )}
        </div>
        {issue.assigneeName && (
          <div
            className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-[9px] font-bold"
            style={{
              backgroundColor: isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)',
            }}
            title={issue.assigneeName}
          >
            {issue.assigneeAvatarUrl ? (
              <img
                src={issue.assigneeAvatarUrl}
                alt=""
                className="w-full h-full rounded-full object-cover"
              />
            ) : (
              issue.assigneeName.charAt(0).toUpperCase()
            )}
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/IssueCard.tsx
git commit -m "feat: add IssueCard component for Convex-powered board"
```

---

### Task 8: IssueDetailPanel Component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/IssueDetailPanel.tsx`

- [ ] **Step 1: Create the detail panel**

```tsx
import { useEffect, useRef } from 'react'
import { isLightColor } from '../utils/color'
import type { Doc } from '../../../../backend/convex/_generated/dataModel'

const STATUSES = [
  { value: 'todo', label: 'Todo' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'in_review', label: 'In Review' },
  { value: 'done', label: 'Done' },
] as const

const STATUS_COLORS: Record<string, string> = {
  todo: '#8b8b8b',
  in_progress: '#f59e0b',
  in_review: '#3b82f6',
  done: '#22c55e',
}

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'No priority', color: '#8b8b8b' },
  1: { label: 'Urgent', color: '#f76a6a' },
  2: { label: 'High', color: '#f59e0b' },
  3: { label: 'Medium', color: '#3b82f6' },
  4: { label: 'Low', color: '#6b7280' },
}

interface IssueDetailPanelProps {
  issue: Doc<'issues'>
  labels: Doc<'issueLabels'>[]
  wsColor: string
  txtColor: string
  onClose: () => void
  onStatusChange: (issueId: string, status: string) => void
  onNavigate: (direction: 'up' | 'down') => void
}

export function IssueDetailPanel({
  issue,
  labels,
  wsColor,
  txtColor,
  onClose,
  onStatusChange,
  onNavigate,
}: IssueDetailPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const isLight = isLightColor(wsColor)
  const bg = isLight ? 'rgba(255,255,255,0.85)' : 'rgba(20,20,35,0.95)'
  const priority = PRIORITY_LABELS[issue.priority] ?? PRIORITY_LABELS[0]
  const statusColor = STATUS_COLORS[issue.status] ?? '#8b8b8b'
  const issueLabels = labels.filter((l) => issue.labelIds.includes(l._id))

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'ArrowUp') { e.preventDefault(); onNavigate('up') }
      if (e.key === 'ArrowDown') { e.preventDefault(); onNavigate('down') }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, onNavigate])

  return (
    <div
      ref={panelRef}
      className="w-[400px] shrink-0 border-l overflow-y-auto"
      style={{
        backgroundColor: bg,
        borderColor: `${txtColor}15`,
        color: txtColor,
      }}
    >
      <div className="sticky top-0 flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: `${txtColor}10`, backgroundColor: bg }}>
        <span className="text-xs font-mono opacity-50">{issue.identifier}</span>
        <div className="flex items-center gap-2">
          {issue.linearUrl && (
            <a
              href={issue.linearUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs opacity-50 hover:opacity-100 transition-opacity"
              title="Open in Linear"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4" />
                <path d="M7 9l7-7" />
                <path d="M10 2h4v4" />
              </svg>
            </a>
          )}
          <button
            onClick={onClose}
            className="text-sm opacity-50 hover:opacity-100 transition-opacity"
          >
            x
          </button>
        </div>
      </div>

      <div className="px-4 pt-4 pb-3">
        <h2 className="text-base font-semibold leading-6">{issue.title}</h2>
      </div>

      <div className="px-4 pb-3 flex flex-wrap items-center gap-2">
        <select
          value={issue.status}
          onChange={(e) => onStatusChange(issue._id, e.target.value)}
          className="text-xs px-2 py-1 rounded-md border appearance-none cursor-pointer"
          style={{
            backgroundColor: `${statusColor}22`,
            borderColor: `${statusColor}44`,
            color: txtColor,
          }}
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value} style={{ backgroundColor: isLight ? '#fff' : '#1a1a2e', color: isLight ? '#000' : '#fff' }}>
              {s.label}
            </option>
          ))}
        </select>

        <span
          className="text-[10px] px-2 py-0.5 rounded-full"
          style={{ backgroundColor: `${priority.color}22`, color: priority.color }}
        >
          {priority.label}
        </span>

        {issue.assigneeName && (
          <span className="text-xs opacity-70">{issue.assigneeName}</span>
        )}
      </div>

      {issueLabels.length > 0 && (
        <div className="px-4 pb-3 flex flex-wrap gap-1">
          {issueLabels.map((label) => (
            <span
              key={label._id}
              className="text-[10px] px-1.5 py-0.5 rounded-full"
              style={{
                backgroundColor: `${label.color}22`,
                color: label.color,
                border: `1px solid ${label.color}44`,
              }}
            >
              {label.name}
            </span>
          ))}
        </div>
      )}

      <div className="px-4 pb-6 border-t pt-4" style={{ borderColor: `${txtColor}10` }}>
        {issue.description ? (
          <pre className="text-sm leading-6 whitespace-pre-wrap font-sans opacity-80">{issue.description}</pre>
        ) : (
          <p className="text-sm opacity-40 italic">No description</p>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/IssueDetailPanel.tsx
git commit -m "feat: add IssueDetailPanel component"
```

---

### Task 9: IssueCreateForm Component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/IssueCreateForm.tsx`

- [ ] **Step 1: Create inline issue creation form**

```tsx
import { useState, useRef, useEffect } from 'react'

type IssueStatus = 'todo' | 'in_progress' | 'in_review' | 'done'

interface IssueCreateFormProps {
  defaultStatus: IssueStatus
  txtColor: string
  isLight: boolean
  onSubmit: (title: string, status: IssueStatus) => void
  onCancel: () => void
}

export function IssueCreateForm({ defaultStatus, txtColor, isLight, onSubmit, onCancel }: IssueCreateFormProps) {
  const [title, setTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = () => {
    const trimmed = title.trim()
    if (!trimmed) return
    onSubmit(trimmed, defaultStatus)
    setTitle('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  const bg = isLight ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.06)'
  const inputBg = isLight ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.08)'

  return (
    <div className="rounded-lg px-3 py-2.5" style={{ backgroundColor: bg }}>
      <input
        ref={inputRef}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (!title.trim()) onCancel() }}
        placeholder="Issue title..."
        className="w-full text-sm bg-transparent outline-none placeholder:opacity-40"
        style={{ color: txtColor }}
      />
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/IssueCreateForm.tsx
git commit -m "feat: add IssueCreateForm inline component"
```

---

### Task 10: IssueBoard — main board component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/IssueBoard.tsx`

- [ ] **Step 1: Create the board component**

```tsx
import { useState, useCallback, useRef } from 'react'
import { useQuery, useMutation, useConvex } from 'convex/react'
import { api } from '../../../../backend/convex/_generated/api'
import { IssueCard } from './IssueCard'
import { IssueDetailPanel } from './IssueDetailPanel'
import { IssueCreateForm } from './IssueCreateForm'
import { importFromLinear, type ImportResult } from '../utils/linear-importer'
import { isLightColor, textColor } from '../utils/color'
import type { Doc, Id } from '../../../../backend/convex/_generated/dataModel'

type IssueStatus = 'todo' | 'in_progress' | 'in_review' | 'done'

const COLUMNS: { status: IssueStatus; label: string; color: string }[] = [
  { status: 'todo', label: 'Todo', color: '#8b8b8b' },
  { status: 'in_progress', label: 'In Progress', color: '#f59e0b' },
  { status: 'in_review', label: 'In Review', color: '#3b82f6' },
  { status: 'done', label: 'Done', color: '#22c55e' },
]

interface IssueBoardProps {
  workspaceId: string
  linearConfig?: {
    apiKey: string
    teamId: string
    teamName: string
    filters?: { assigneeIds?: string[]; labelIds?: string[]; stateIds?: string[] }
    importIntervalMinutes?: number
  }
  wsColor: string
  onOpenSettings: () => void
}

export function IssueBoard({ workspaceId, linearConfig, wsColor, onOpenSettings }: IssueBoardProps) {
  const convex = useConvex()
  const issues = useQuery(api.issues.listByWorkspace, { workspaceId })
  const labels = useQuery(api.issueLabels.listByWorkspace, { workspaceId }) ?? []
  const createIssue = useMutation(api.issues.create)
  const updateStatus = useMutation(api.issues.updateStatus)

  const txtColor = textColor(wsColor)
  const isLight = isLightColor(wsColor)

  const [selectedIssue, setSelectedIssue] = useState<Doc<'issues'> | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<IssueStatus | null>(null)
  const [creatingInColumn, setCreatingInColumn] = useState<IssueStatus | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'error' | 'info' } | null>(null)
  const [importing, setImporting] = useState(false)
  const dragIssueRef = useRef<Doc<'issues'> | null>(null)

  const showToast = useCallback((message: string, type: 'error' | 'info' = 'error') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3000)
  }, [])

  // ── Drag and drop ──────────────────────────────────────────────────
  const handleDragStart = useCallback((e: React.DragEvent, issue: Doc<'issues'>) => {
    dragIssueRef.current = issue
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', issue._id)
    ;(e.currentTarget as HTMLElement).style.opacity = '0.5'
  }, [])

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    ;(e.currentTarget as HTMLElement).style.opacity = '1'
    setDragOverColumn(null)
    dragIssueRef.current = null
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, status: IssueStatus) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverColumn(status)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverColumn(null)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent, targetStatus: IssueStatus) => {
    e.preventDefault()
    setDragOverColumn(null)
    const issue = dragIssueRef.current
    if (!issue || issue.status === targetStatus) return

    const columnIssues = (issues ?? []).filter((i) => i.status === targetStatus)
    const maxPosition = columnIssues.reduce((max, i) => Math.max(max, i.position), 0)

    try {
      await updateStatus({
        id: issue._id,
        status: targetStatus,
        position: maxPosition + 1,
      })
    } catch {
      showToast('Failed to update status')
    }
  }, [issues, updateStatus, showToast])

  // ── Status change from detail panel ────────────────────────────────
  const handleStatusChange = useCallback(async (issueId: string, status: string) => {
    const columnIssues = (issues ?? []).filter((i) => i.status === status)
    const maxPosition = columnIssues.reduce((max, i) => Math.max(max, i.position), 0)

    try {
      await updateStatus({
        id: issueId as Id<'issues'>,
        status: status as IssueStatus,
        position: maxPosition + 1,
      })
    } catch {
      showToast('Failed to update status')
    }
  }, [issues, updateStatus, showToast])

  // ── Navigation ─────────────────────────────────────────────────────
  const handleNavigate = useCallback((direction: 'up' | 'down') => {
    if (!selectedIssue || !issues) return
    const columnIssues = issues
      .filter((i) => i.status === selectedIssue.status)
      .sort((a, b) => a.position - b.position)
    const idx = columnIssues.findIndex((i) => i._id === selectedIssue._id)
    if (idx < 0) return
    const nextIdx = direction === 'up' ? idx - 1 : idx + 1
    if (nextIdx >= 0 && nextIdx < columnIssues.length) {
      setSelectedIssue(columnIssues[nextIdx])
    }
  }, [selectedIssue, issues])

  // ── Create issue ───────────────────────────────────────────────────
  const handleCreateIssue = useCallback(async (title: string, status: IssueStatus) => {
    const columnIssues = (issues ?? []).filter((i) => i.status === status)
    const maxPosition = columnIssues.reduce((max, i) => Math.max(max, i.position), 0)

    try {
      await createIssue({
        workspaceId,
        title,
        status,
        priority: 0,
        labelIds: [],
        position: maxPosition + 1,
      })
      setCreatingInColumn(null)
    } catch {
      showToast('Failed to create issue')
    }
  }, [workspaceId, issues, createIssue, showToast])

  // ── Import from Linear ─────────────────────────────────────────────
  const handleImport = useCallback(async () => {
    if (!linearConfig || importing) return
    setImporting(true)
    try {
      const decryptedKey = await window.electronAPI.linearDecryptKey(linearConfig.apiKey)
      const result = await importFromLinear(
        convex,
        workspaceId,
        decryptedKey,
        linearConfig.teamId,
        linearConfig.filters,
      )
      showToast(`Imported: ${result.created} new, ${result.updated} updated`, 'info')
    } catch (err: any) {
      const msg = err?.message ?? 'Import failed'
      if (msg === 'LINEAR_UNAUTHORIZED') {
        showToast('Linear API key is invalid or expired')
      } else if (msg === 'LINEAR_RATE_LIMITED') {
        showToast('Rate limited by Linear — try again later')
      } else {
        showToast('Failed to import from Linear')
      }
    } finally {
      setImporting(false)
    }
  }, [linearConfig, importing, convex, workspaceId, showToast])

  // ── Loading state ──────────────────────────────────────────────────
  if (issues === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: txtColor }}>
        <span className="text-sm opacity-50">Loading board...</span>
      </div>
    )
  }

  // Keep selected issue in sync with reactive data
  const currentSelected = selectedIssue
    ? issues.find((i) => i._id === selectedIssue._id) ?? null
    : null

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* Board header */}
      <div className="flex items-center justify-between px-4 py-2 shrink-0 border-b" style={{ borderColor: `${txtColor}10` }}>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium" style={{ color: txtColor }}>Issues</span>
          <span className="text-xs opacity-40" style={{ color: txtColor }}>{issues.length}</span>
        </div>
        <div className="flex items-center gap-3">
          {linearConfig && (
            <button
              onClick={handleImport}
              disabled={importing}
              className="text-xs opacity-50 hover:opacity-100 transition-opacity disabled:opacity-30"
              style={{ color: txtColor }}
              title="Import from Linear"
            >
              {importing ? 'Importing...' : 'Import from Linear'}
            </button>
          )}
        </div>
      </div>

      {/* Columns */}
      <div className="flex-1 flex overflow-x-auto overflow-y-hidden">
        {COLUMNS.map((column) => {
          const columnIssues = issues
            .filter((i) => i.status === column.status)
            .sort((a, b) => a.position - b.position)
          const isDragOver = dragOverColumn === column.status

          return (
            <div
              key={column.status}
              className="flex flex-col min-w-[260px] max-w-[320px] flex-1 border-r last:border-r-0"
              style={{ borderColor: `${txtColor}08` }}
              onDragOver={(e) => handleDragOver(e, column.status)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, column.status)}
            >
              <div className="flex items-center gap-2 px-3 py-2.5 shrink-0">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: column.color }}
                />
                <span className="text-xs font-medium truncate" style={{ color: txtColor }}>
                  {column.label}
                </span>
                <span className="text-[10px] opacity-30" style={{ color: txtColor }}>
                  {columnIssues.length}
                </span>
                <button
                  onClick={() => setCreatingInColumn(column.status)}
                  className="ml-auto text-sm opacity-30 hover:opacity-70 transition-opacity"
                  style={{ color: txtColor }}
                  title="Add issue"
                >
                  +
                </button>
              </div>

              <div
                className="flex-1 overflow-y-auto px-2 pb-2 space-y-1.5 transition-colors"
                style={{
                  backgroundColor: isDragOver
                    ? (isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.04)')
                    : 'transparent',
                }}
              >
                {creatingInColumn === column.status && (
                  <IssueCreateForm
                    defaultStatus={column.status}
                    txtColor={txtColor}
                    isLight={isLight}
                    onSubmit={handleCreateIssue}
                    onCancel={() => setCreatingInColumn(null)}
                  />
                )}
                {columnIssues.map((issue) => (
                  <div key={issue._id} onDragEnd={handleDragEnd}>
                    <IssueCard
                      issue={issue}
                      labels={labels}
                      txtColor={txtColor}
                      isLight={isLight}
                      onClick={() => setSelectedIssue(issue)}
                      onDragStart={(e) => handleDragStart(e, issue)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )
        })}

        {currentSelected && (
          <IssueDetailPanel
            issue={currentSelected}
            labels={labels}
            wsColor={wsColor}
            txtColor={txtColor}
            onClose={() => setSelectedIssue(null)}
            onStatusChange={handleStatusChange}
            onNavigate={handleNavigate}
          />
        )}
      </div>

      {toast && (
        <div
          className="absolute bottom-4 right-4 px-4 py-2 rounded-lg text-sm shadow-lg z-50"
          style={{
            backgroundColor: toast.type === 'error' ? '#dc2626' : `${txtColor}15`,
            color: toast.type === 'error' ? '#fff' : txtColor,
          }}
        >
          {toast.message}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/IssueBoard.tsx
git commit -m "feat: add IssueBoard component with Convex reactive queries and drag-and-drop"
```

---

### Task 11: Wire IssueBoard into App and remove LinearBoard

**Files:**
- Modify: `apps/desktop/src/renderer/src/App.tsx`

- [ ] **Step 1: Replace LinearBoard import with IssueBoard**

In `apps/desktop/src/renderer/src/App.tsx`, change the import on line 20:

Replace:
```typescript
import { LinearBoard } from './components/LinearBoard'
```

With:
```typescript
import { IssueBoard } from './components/IssueBoard'
```

- [ ] **Step 2: Replace LinearBoard usage with IssueBoard**

Around line 260-266, replace:
```tsx
              ) : activeWorkspace?.viewMode === 'board' ? (
                <LinearBoard
                  workspaceId={activeWorkspace.id}
                  linearConfig={activeWorkspace.linearConfig}
                  wsColor={panelColor}
                  onOpenSettings={() => useAppStore.getState().setShowWorkspaceSettings(true)}
                />
```

With:
```tsx
              ) : activeWorkspace?.viewMode === 'board' ? (
                <IssueBoard
                  workspaceId={activeWorkspace.id}
                  linearConfig={activeWorkspace.linearConfig}
                  wsColor={panelColor}
                  onOpenSettings={() => useAppStore.getState().setShowWorkspaceSettings(true)}
                />
```

- [ ] **Step 3: Remove old Linear board files**

Delete:
- `apps/desktop/src/renderer/src/components/LinearBoard.tsx`
- `apps/desktop/src/renderer/src/components/LinearTicketCard.tsx`
- `apps/desktop/src/renderer/src/components/LinearDetailPanel.tsx`
- `apps/desktop/src/renderer/src/hooks/useLinearBoard.ts`

- [ ] **Step 4: Remove Zustand linear board cache from store**

In `apps/desktop/src/renderer/src/store/app-store.ts`, remove:
- The `linearBoardCache` and `linearMutationInflight` state fields
- The `setLinearBoardCache`, `clearLinearBoardCache`, `setLinearMutationInflight` functions
- Any references to these in the `deleteWorkspace` action
- The import of `LinearBoardData` from `linear-types`

- [ ] **Step 5: Verify build**

```bash
cd apps/desktop && bun run build
```
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: replace LinearBoard with Convex-powered IssueBoard"
```

---

### Task 12: Settings Dialog — Linear import filters

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/SettingsDialog.tsx`

- [ ] **Step 1: Add filter state variables**

In the SettingsDialog component, after the existing linear state variables (around line 94), add:

```typescript
const [linearMembers, setLinearMembers] = useState<{ id: string; name: string; displayName: string }[]>([])
const [linearLabelsOptions, setLinearLabelsOptions] = useState<{ id: string; name: string; color: string }[]>([])
const [linearStates, setLinearStates] = useState<{ id: string; name: string; type: string }[]>([])
const [filterAssigneeIds, setFilterAssigneeIds] = useState<string[]>(linearConfig?.filters?.assigneeIds ?? [])
const [filterLabelIds, setFilterLabelIds] = useState<string[]>(linearConfig?.filters?.labelIds ?? [])
const [filterStateIds, setFilterStateIds] = useState<string[]>(linearConfig?.filters?.stateIds ?? [])
const [filtersLoading, setFiltersLoading] = useState(false)
```

- [ ] **Step 2: Add function to load filter options**

After the `handleLinearKeySubmit` function, add:

```typescript
const loadFilterOptions = async () => {
  if (!linearConfig || filtersLoading) return
  setFiltersLoading(true)
  try {
    const decryptedKey = await window.electronAPI.linearDecryptKey(linearConfig.apiKey)
    const { fetchTeamMembers, fetchTeamLabels, fetchBoardData } = await import('../utils/linear-client')
    const [members, labelsResult, boardData] = await Promise.all([
      fetchTeamMembers(decryptedKey, linearConfig.teamId),
      fetchTeamLabels(decryptedKey, linearConfig.teamId),
      fetchBoardData(decryptedKey, linearConfig.teamId),
    ])
    setLinearMembers(members)
    setLinearLabelsOptions(labelsResult)
    setLinearStates(boardData.columns.filter((c) => c.type !== 'cancelled'))
  } catch {
    // silently fail — filter options just won't show
  } finally {
    setFiltersLoading(false)
  }
}
```

- [ ] **Step 3: Add function to save filters**

```typescript
const handleSaveFilters = () => {
  if (!linearConfig) return
  onSaveLinearConfig({
    ...linearConfig,
    filters: {
      assigneeIds: filterAssigneeIds.length ? filterAssigneeIds : undefined,
      labelIds: filterLabelIds.length ? filterLabelIds : undefined,
      stateIds: filterStateIds.length ? filterStateIds : undefined,
    },
  })
  showToast('Filters saved', 'info')
}
```

Note: `onSaveLinearConfig` and the `Workspace` type need to accept the extended config shape. The `Workspace` type was updated in Task 5 Step 1.

- [ ] **Step 4: Add filter UI to the Linear settings page**

Inside the `{page === 'linear' && (` section, after the connected team info and before the closing `</>`, add the filter configuration UI:

```tsx
{linearConnected && (
  <div className="space-y-4 mt-4 pt-4 border-t" style={{ borderColor: borderClr }}>
    <div className="flex items-center justify-between">
      <span className="text-sm font-medium" style={{ color: txt }}>Import Filters</span>
      <button
        onClick={loadFilterOptions}
        disabled={filtersLoading}
        className="text-xs px-3 py-1 rounded-md transition-colors"
        style={{ color: txt, backgroundColor: subtleBg }}
      >
        {filtersLoading ? 'Loading...' : linearMembers.length ? 'Refresh' : 'Load Options'}
      </button>
    </div>

    {linearMembers.length > 0 && (
      <>
        <div>
          <label className="text-xs block mb-1" style={{ color: mutedTxt }}>Assignees</label>
          <div className="flex flex-wrap gap-1">
            {linearMembers.map((m) => (
              <button
                key={m.id}
                onClick={() => setFilterAssigneeIds((prev) =>
                  prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...prev, m.id]
                )}
                className="text-[11px] px-2 py-1 rounded-md border transition-colors"
                style={{
                  borderColor: filterAssigneeIds.includes(m.id) ? `${txt}60` : borderClr,
                  backgroundColor: filterAssigneeIds.includes(m.id) ? `${txt}15` : 'transparent',
                  color: txt,
                }}
              >
                {m.displayName}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs block mb-1" style={{ color: mutedTxt }}>Labels</label>
          <div className="flex flex-wrap gap-1">
            {linearLabelsOptions.map((l) => (
              <button
                key={l.id}
                onClick={() => setFilterLabelIds((prev) =>
                  prev.includes(l.id) ? prev.filter((id) => id !== l.id) : [...prev, l.id]
                )}
                className="text-[11px] px-2 py-1 rounded-full border transition-colors"
                style={{
                  borderColor: filterLabelIds.includes(l.id) ? `${l.color}88` : `${l.color}44`,
                  backgroundColor: filterLabelIds.includes(l.id) ? `${l.color}22` : 'transparent',
                  color: l.color,
                }}
              >
                {l.name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs block mb-1" style={{ color: mutedTxt }}>Statuses</label>
          <div className="flex flex-wrap gap-1">
            {linearStates.map((s) => (
              <button
                key={s.id}
                onClick={() => setFilterStateIds((prev) =>
                  prev.includes(s.id) ? prev.filter((id) => id !== s.id) : [...prev, s.id]
                )}
                className="text-[11px] px-2 py-1 rounded-md border transition-colors"
                style={{
                  borderColor: filterStateIds.includes(s.id) ? `${txt}60` : borderClr,
                  backgroundColor: filterStateIds.includes(s.id) ? `${txt}15` : 'transparent',
                  color: txt,
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={handleSaveFilters}
          className="text-xs px-4 py-2 rounded-md transition-colors"
          style={{ color: txt, backgroundColor: subtleBg }}
        >
          Save Filters
        </button>
      </>
    )}

    {!linearMembers.length && !filtersLoading && (
      <p className="text-xs opacity-50" style={{ color: txt }}>
        Click "Load Options" to configure which Linear issues to import.
      </p>
    )}
  </div>
)}
```

- [ ] **Step 5: Verify build**

```bash
cd apps/desktop && bun run build
```
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/SettingsDialog.tsx
git commit -m "feat: add Linear import filter configuration to settings"
```

---

### Task 13: Background periodic import

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/IssueBoard.tsx`

- [ ] **Step 1: Add periodic import via useEffect**

In `IssueBoard.tsx`, add a `useEffect` after the `handleImport` callback for background periodic import:

```typescript
// ── Periodic background import ──────────────────────────────────────
const importIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

useEffect(() => {
  if (!linearConfig) return

  const intervalMinutes = linearConfig.importIntervalMinutes ?? 30
  const intervalMs = intervalMinutes * 60 * 1000

  // Run initial import on mount
  const doImport = async () => {
    if (importing) return
    try {
      const decryptedKey = await window.electronAPI.linearDecryptKey(linearConfig.apiKey)
      await importFromLinear(convex, workspaceId, decryptedKey, linearConfig.teamId, linearConfig.filters)
    } catch {
      // Silent fail for background import
    }
  }

  doImport()
  importIntervalRef.current = setInterval(doImport, intervalMs)

  return () => {
    if (importIntervalRef.current) clearInterval(importIntervalRef.current)
  }
}, [linearConfig?.teamId, linearConfig?.apiKey, workspaceId]) // intentionally sparse deps — only re-setup on config change
```

- [ ] **Step 2: Verify build**

```bash
cd apps/desktop && bun run build
```
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/IssueBoard.tsx
git commit -m "feat: add periodic background import from Linear"
```

---

### Task 14: Final cleanup and build verification

**Files:**
- Various cleanup

- [ ] **Step 1: Remove unused linear-types if no longer needed**

Check if `apps/desktop/src/shared/linear-types.ts` is still imported anywhere. The `fetchBoardData` in `linear-client.ts` still uses these types, and `linear-importer.ts` imports `LinearIssue`. Keep the file — it's still used by the import pipeline.

- [ ] **Step 2: Clean up any unused imports in app-store.ts**

Verify the `LinearBoardData` import and all `linearBoardCache`/`linearMutationInflight` references were removed in Task 11.

- [ ] **Step 3: Full build and manual test**

```bash
cd apps/desktop && bun run build
```
Expected: Build succeeds with no errors.

Manual test checklist:
- Board view shows 4 columns (Todo, In Progress, In Review, Done)
- "+" button on each column opens inline create form
- Typing a title and pressing Enter creates an issue
- Dragging an issue between columns updates its status
- Clicking an issue opens the detail panel
- Settings > Linear > filter config works (load options, select filters, save)
- "Import from Linear" button fetches and imports issues
- Real-time: opening a second window shows the same data, changes appear instantly

- [ ] **Step 4: Commit any remaining cleanup**

```bash
git add -A
git commit -m "chore: final cleanup for Convex-powered ticketing system"
```
