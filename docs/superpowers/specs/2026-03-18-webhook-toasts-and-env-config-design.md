# Webhook Toasts & Env-Based Convex Config

**Date:** 2026-03-18
**Status:** Draft

## Problem

1. Convex deployment URLs are hardcoded in `convex-config.ts` — fragile, can't switch between dev/prod deployments
2. No visibility into webhook filter decisions — when a webhook arrives and the LLM evaluates the filter, there's no feedback on what happened, why it passed or was filtered, or what the payload/prompt were

## Solution

### 1. Env-Based Convex Config

Replace hardcoded URLs in `apps/desktop/src/main/convex-config.ts` with electron-vite env vars.

**Files:**

- `apps/desktop/.env` — prod defaults:
  ```
  MAIN_VITE_CONVEX_CLOUD_URL=https://reminiscent-malamute-957.convex.cloud
  MAIN_VITE_CONVEX_SITE_URL=https://reminiscent-malamute-957.convex.site
  ```

- `apps/desktop/.env.development` — dev deployment (same for now, swap when a separate dev deployment exists):
  ```
  MAIN_VITE_CONVEX_CLOUD_URL=https://reminiscent-malamute-957.convex.cloud
  MAIN_VITE_CONVEX_SITE_URL=https://reminiscent-malamute-957.convex.site
  ```

- `apps/desktop/src/main/convex-config.ts`:
  ```ts
  export const CONVEX_CLOUD_URL = import.meta.env.MAIN_VITE_CONVEX_CLOUD_URL
  export const CONVEX_SITE_URL = import.meta.env.MAIN_VITE_CONVEX_SITE_URL
  ```

electron-vite automatically loads `.env.development` during `bun run dev` and `.env` during `bun run build`. The `MAIN_VITE_` prefix exposes vars to the main process via `import.meta.env`.

**Add `.env.development` to the root `.gitignore`** so each developer can point to their own Convex deployment. Commit `.env` as the prod defaults.

### 2. Backend — Denormalize Filter Prompt & Add Notification Query

#### Schema Change

Add `filterPrompt` to `webhookEvents` table in `apps/backend/convex/schema.ts`:

```ts
webhookEvents: defineTable({
  // ... existing fields ...
  filterPrompt: v.optional(v.string()), // the plain-English condition at evaluation time
})
```

#### HTTP Handler Change

In `apps/backend/convex/http.ts`, restructure the event creation into three distinct code paths:

**Path 1 — Filter rejects (filtered out):**
```ts
if (webhook.filter) {
  const filterResult = await ctx.runAction(api.webhookFilter.evaluateFilter, {
    filter: webhook.filter,
    payload,
  }) as { pass: boolean; reason: string };

  if (!filterResult.pass) {
    await ctx.runMutation(internal.webhooks.createEvent, {
      webhookId: webhook._id,
      token,
      workspaceId: webhook.workspaceId,
      actionId: webhook.actionId,
      payload,
      filterPrompt: webhook.filter,      // capture the condition at evaluation time
      filterResult: filterResult.reason,
      filtered: true,
    });
    return new Response(...);
  }

  // Path 2 — Filter passes:
  await ctx.runMutation(internal.webhooks.createEvent, {
    webhookId: webhook._id,
    token,
    workspaceId: webhook.workspaceId,
    actionId: webhook.actionId,
    payload,
    filterPrompt: webhook.filter,        // capture even for passing events
    filterResult: filterResult.reason,   // capture pass reason too
  });
} else {
  // Path 3 — No filter at all:
  await ctx.runMutation(internal.webhooks.createEvent, {
    webhookId: webhook._id,
    token,
    workspaceId: webhook.workspaceId,
    actionId: webhook.actionId,
    payload,
  });
}
```

#### createEvent Mutation

Update `createEvent` args to accept `filterPrompt`:

```ts
export const createEvent = internalMutation({
  args: {
    // ... existing args ...
    filterPrompt: v.optional(v.string()),
  },
  handler: async (ctx, { filtered, ...args }) => {
    return await ctx.db.insert("webhookEvents", {
      ...args,
      status: filtered ? "filtered" : "pending",
      createdAt: Date.now(),
    });
  },
});
```

#### New Query: `getRecentEventNotifications`

In `apps/backend/convex/webhooks.ts`:

```ts
export const getRecentEventNotifications = query({
  args: { since: v.number() },
  handler: async (ctx, { since }) => {
    return await ctx.db
      .query("webhookEvents")
      .withIndex("by_created", (q) => q.gt("createdAt", since))
      .order("desc")
      .take(20);
  },
});
```

Returns events of ANY status created after the given timestamp, limited to 20.

### 3. Desktop — Notification Polling

In `apps/desktop/src/main/webhook-listener.ts`:

#### New State

```ts
let lastNotifiedAt: number = Date.now()
```

#### Modified Poll Cycle

In `pollAndProcess()`, alongside the existing `getPendingEvents` call, also query for recent events:

```ts
// Existing: process pending events
const events = await convexQuery('webhooks:getPendingEvents') as PendingEvent[] | null
// ... existing processing ...

// NEW: fetch recent events for toast notifications
const recentEvents = await convexQuery('webhooks:getRecentEventNotifications', { since: lastNotifiedAt }) as WebhookEventNotification[] | null
if (recentEvents && recentEvents.length > 0) {
  lastNotifiedAt = Math.max(...recentEvents.map(e => e.createdAt))
  for (const event of recentEvents) {
    sendWebhookNotification(event)
  }
}
```

#### Resolve Local Context & Send IPC

```ts
interface WebhookEventNotification {
  _id: string
  token: string
  workspaceId: string
  actionId: string
  payload: unknown
  status: string
  filterPrompt?: string
  filterResult?: string
  createdAt: number
}

function sendWebhookNotification(event: WebhookEventNotification): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const data = loadPersistedData()
  const workspace = data.workspaces[event.workspaceId]
  const action = workspace?.customActions.find(a => a.id === event.actionId)

  mainWindow.webContents.send('webhook-event-notification', {
    actionName: action?.name ?? 'Unknown Action',
    workspaceName: workspace?.name ?? 'Unknown',
    workspaceColor: workspace?.color ?? '#2a2a3e',
    status: event.status as 'pending' | 'filtered',
    payload: event.payload,
    filterPrompt: event.filterPrompt,
    filterResult: event.filterResult,
    filterPassed: event.status !== 'filtered',
    createdAt: event.createdAt,
  })
}
```

### 4. Preload & Types

#### New IPC type in `src/shared/types.ts`:

```ts
export interface WebhookEventToast {
  actionName: string
  workspaceName: string
  workspaceColor: string
  status: 'pending' | 'filtered'
  payload: unknown
  filterPrompt?: string
  filterResult?: string
  filterPassed: boolean
  createdAt: number
}
```

#### ElectronAPI addition:

```ts
onWebhookEventNotification: (callback: (data: WebhookEventToast) => void) => () => void
```

#### Preload bridge:

```ts
onWebhookEventNotification: (callback: (data: WebhookEventToast) => void) => {
  const handler = (_event: any, data: WebhookEventToast) => callback(data)
  ipcRenderer.on('webhook-event-notification', handler)
  return () => { ipcRenderer.removeListener('webhook-event-notification', handler) }
},
```

Add `'webhook-event-notification'` to `removeAllListeners`.

### 5. Renderer — Expandable Webhook Toasts (Dev-Only)

#### Toast entry type

```ts
// In WebhookToast.tsx
interface WebhookToastEntry extends WebhookEventToast {
  id: string
  fadingOut: boolean
  expanded: boolean
}
```

#### Hook: extend `useWebhooks.ts`

Listen for `webhook-event-notification`, maintain toast state:

```ts
export function useWebhooks() {
  const [webhookToasts, setWebhookToasts] = useState<WebhookToastEntry[]>([])
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismissWebhookToast = useCallback((id: string) => {
    setWebhookToasts(prev => prev.map(t => t.id === id ? { ...t, fadingOut: true } : t))
    setTimeout(() => {
      setWebhookToasts(prev => prev.filter(t => t.id !== id))
    }, 300)
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const toggleWebhookToastExpand = useCallback((id: string) => {
    setWebhookToasts(prev => prev.map(t => t.id === id ? { ...t, expanded: !t.expanded } : t))
  }, [])

  useEffect(() => {
    // Existing: onWebhookRunAction listener
    const unsubRun = window.electronAPI.onWebhookRunAction(({ workspaceId, actionId }) => {
      const state = useAppStore.getState()
      const workspace = state.workspaces[workspaceId]
      if (!workspace) return
      const action = workspace.customActions.find(a => a.id === actionId)
      if (!action) return
      state.runAction(workspaceId, action)
    })

    // NEW: webhook event notifications (dev only)
    let unsubNotify: (() => void) | undefined
    if (import.meta.env.DEV) {
      unsubNotify = window.electronAPI.onWebhookEventNotification((data) => {
        const id = crypto.randomUUID()
        setWebhookToasts(prev => [...prev, { ...data, id, fadingOut: false, expanded: false }])
        const timer = setTimeout(() => dismissWebhookToast(id), 15_000)
        timersRef.current.set(id, timer)
      })
    }

    return () => {
      unsubRun()
      unsubNotify?.()
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [dismissWebhookToast])

  return { webhookToasts, dismissWebhookToast, toggleWebhookToastExpand }
}
```

#### Component: `WebhookToastContainer`

New file: `apps/desktop/src/renderer/src/components/WebhookToast.tsx`.

Positioned below the existing `ToastContainer` using `fixed top-20` (idle toasts use `top-4`), so they stack vertically without overlapping.

**Collapsed state:**
- Workspace color dot + action name
- Badge: green "Triggered" or amber "Filtered"
- One-line LLM reason (truncated to ~80 chars)
- Chevron icon to expand

**Expanded state (click chevron):**
- Full LLM reasoning text
- Filter prompt in a mono-styled box with subtle background
- Payload as formatted JSON in a scrollable `<pre>` (max-height 200px) with copy-to-clipboard button

Styled consistently with existing toast system (workspace color background, same border/shadow treatment).

#### App.tsx integration

```tsx
// In App.tsx
const { webhookToasts, dismissWebhookToast, toggleWebhookToastExpand } = useWebhooks()

// In JSX, after existing ToastContainer:
{import.meta.env.DEV && (
  <WebhookToastContainer
    toasts={webhookToasts}
    onDismiss={dismissWebhookToast}
    onToggleExpand={toggleWebhookToastExpand}
  />
)}
```

### 6. Dev-Only Gating (Main Process)

The notification polling in `webhook-listener.ts` should also be gated:

```ts
// Only query for toast notifications in dev builds
if (process.env.NODE_ENV !== 'production') {
  const recentEvents = await convexQuery(...)
  // ... send IPC notifications
}
```

This avoids the extra Convex API call per poll cycle in production builds.

### 7. Notes

- **Startup timing:** `lastNotifiedAt` is initialized to `Date.now()`, so events created before app startup are intentionally ignored (no stale toasts on restart).
- **Window unavailable:** If `mainWindow` is null when `sendWebhookNotification` fires, the event is silently dropped. The `lastNotifiedAt` timestamp still advances, so those events won't re-appear. This is acceptable — the toasts are ephemeral dev aids.
- **API call overhead:** The notification query adds one extra Convex HTTP request per poll cycle (dev only). Negligible for a single-user desktop app.
- **Security:** The Convex queries (`getPendingEvents`, `getRecentEventNotifications`) are unauthenticated public queries, consistent with the existing webhook system. Future work could add a shared-secret arg or Convex auth.

### 8. Files Changed

| File | Change |
|------|--------|
| `apps/desktop/.env` | NEW — prod Convex URLs |
| `apps/desktop/.env.development` | NEW — dev Convex URLs |
| `.gitignore` (root) | Add `.env.development` |
| `apps/desktop/src/main/convex-config.ts` | Read from `import.meta.env` |
| `apps/backend/convex/schema.ts` | Add `filterPrompt` field |
| `apps/backend/convex/http.ts` | Pass `filterPrompt` and `filterResult` for all events |
| `apps/backend/convex/webhooks.ts` | Update `createEvent` args, add `getRecentEventNotifications` query |
| `apps/desktop/src/main/webhook-listener.ts` | Add notification polling, `sendWebhookNotification` |
| `apps/desktop/src/shared/types.ts` | Add `WebhookEventToast` interface |
| `apps/desktop/src/preload/index.ts` | Add `onWebhookEventNotification` bridge |
| `apps/desktop/src/renderer/src/hooks/useWebhooks.ts` | Add toast state management |
| `apps/desktop/src/renderer/src/components/WebhookToast.tsx` | NEW — expandable toast component |
| `apps/desktop/src/renderer/src/App.tsx` | Render `WebhookToastContainer` (dev-only) |
