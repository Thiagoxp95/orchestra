# Webhook Toasts & Env-Based Convex Config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded Convex URLs with env-based config, and add dev-only expandable toast notifications showing webhook filter decisions (payload, LLM prompt, LLM reasoning).

**Architecture:** The Convex URLs move to `.env` files loaded by electron-vite. The backend denormalizes filter prompt onto webhook events and exposes a new notification query. The desktop poll loop gains a parallel dev-only notification query that sends IPC to the renderer. The renderer shows expandable toasts with full filter context.

**Tech Stack:** Electron + electron-vite, Convex backend, React 19, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-18-webhook-toasts-and-env-config-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/desktop/.env` | CREATE | Prod Convex URLs |
| `apps/desktop/.env.development` | CREATE | Dev Convex URLs |
| `.gitignore` | MODIFY | Add `.env.development` |
| `apps/desktop/src/main/convex-config.ts` | MODIFY | Read URLs from `import.meta.env` |
| `apps/backend/convex/schema.ts` | MODIFY | Add `filterPrompt` field to `webhookEvents` |
| `apps/backend/convex/webhooks.ts` | MODIFY | Add `filterPrompt` arg to `createEvent`, add `getRecentEventNotifications` query |
| `apps/backend/convex/http.ts` | MODIFY | Restructure event creation into 3 code paths with filter data |
| `apps/desktop/src/shared/types.ts` | MODIFY | Add `WebhookEventToast` interface |
| `apps/desktop/src/preload/index.ts` | MODIFY | Add `onWebhookEventNotification` bridge |
| `apps/desktop/src/main/webhook-listener.ts` | MODIFY | Add dev-only notification polling + `sendWebhookNotification` |
| `apps/desktop/src/renderer/src/hooks/useWebhooks.ts` | MODIFY | Add toast state management, return toast data |
| `apps/desktop/src/renderer/src/components/WebhookToast.tsx` | CREATE | Expandable webhook toast component |
| `apps/desktop/src/renderer/src/App.tsx` | MODIFY | Wire webhook toasts from `useWebhooks`, render `WebhookToastContainer` (dev-only) |

---

### Task 1: Env-Based Convex Config

**Files:**
- Create: `apps/desktop/.env`
- Create: `apps/desktop/.env.development`
- Modify: `.gitignore:1-10`
- Modify: `apps/desktop/src/main/convex-config.ts:1-7`

- [ ] **Step 1: Create `.env` with prod defaults**

```
# apps/desktop/.env
MAIN_VITE_CONVEX_CLOUD_URL=https://reminiscent-malamute-957.convex.cloud
MAIN_VITE_CONVEX_SITE_URL=https://reminiscent-malamute-957.convex.site
```

- [ ] **Step 2: Create `.env.development` with dev URLs**

```
# apps/desktop/.env.development
MAIN_VITE_CONVEX_CLOUD_URL=https://reminiscent-malamute-957.convex.cloud
MAIN_VITE_CONVEX_SITE_URL=https://reminiscent-malamute-957.convex.site
```

(Same URLs for now — swap when a separate dev deployment exists.)

- [ ] **Step 3: Add `.env.development` to root `.gitignore`**

Add these lines to the end of `.gitignore`:

```
# Local env overrides
.env.development
.env.local
```

- [ ] **Step 4: Update `convex-config.ts` to read from env**

Replace the entire file `apps/desktop/src/main/convex-config.ts`:

```ts
// Shared Convex deployment URLs.
// Loaded from .env (prod) or .env.development (dev) by electron-vite.
// The MAIN_VITE_ prefix exposes vars to the main process via import.meta.env.

export const CONVEX_CLOUD_URL = import.meta.env.MAIN_VITE_CONVEX_CLOUD_URL as string
export const CONVEX_SITE_URL = import.meta.env.MAIN_VITE_CONVEX_SITE_URL as string
```

- [ ] **Step 5: Verify the app starts**

Run: `cd apps/desktop && bun run dev`
Expected: App starts without errors, webhook listener still uses the correct Convex URLs.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/.env apps/desktop/.env.development .gitignore apps/desktop/src/main/convex-config.ts
git commit -m "refactor: replace hardcoded Convex URLs with env-based config"
```

---

### Task 2: Backend — Schema & Mutation Changes

**Files:**
- Modify: `apps/backend/convex/schema.ts:24-43`
- Modify: `apps/backend/convex/webhooks.ts:89-106`

- [ ] **Step 1: Add `filterPrompt` to schema**

In `apps/backend/convex/schema.ts`, add `filterPrompt` field to `webhookEvents` table after `filterResult` (line 38):

```ts
    filterResult: v.optional(v.string()), // LLM reasoning for filter decision
    filterPrompt: v.optional(v.string()), // plain-English condition at evaluation time
```

- [ ] **Step 2: Add `filterPrompt` to `createEvent` mutation args**

In `apps/backend/convex/webhooks.ts`, add to the `createEvent` args (after line 97):

```ts
    filterPrompt: v.optional(v.string()),
```

The handler already uses `...args` spread, so `filterPrompt` will be inserted into the DB automatically.

- [ ] **Step 3: Add `getRecentEventNotifications` query**

In `apps/backend/convex/webhooks.ts`, add after the `getPendingEvents` query (after line 24):

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

- [ ] **Step 4: Push schema to Convex**

Run: `cd apps/backend && npx convex dev`
Expected: Schema pushes without errors. The `webhookEvents` table now has `filterPrompt`.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/convex/schema.ts apps/backend/convex/webhooks.ts
git commit -m "feat: add filterPrompt to webhook events and notification query"
```

---

### Task 3: Backend — HTTP Handler Restructuring

**Files:**
- Modify: `apps/backend/convex/http.ts:126-162`

- [ ] **Step 1: Restructure the webhook handler's event creation into 3 paths**

Replace the section in `apps/backend/convex/http.ts` from line 126 (`// If the webhook has a filter`) through line 162 (the closing `});` of the second `createEvent` call). The success `return new Response(JSON.stringify({ ok: true }), ...)` on lines 164-167 remains untouched. Replace with:

```ts
    // If the webhook has a filter, evaluate it with the LLM
    if (webhook.filter) {
      const filterResult = await ctx.runAction(api.webhookFilter.evaluateFilter, {
        filter: webhook.filter,
        payload,
      }) as { pass: boolean; reason: string };

      if (!filterResult.pass) {
        // Path 1 — Filter rejects: store as filtered for auditability
        await ctx.runMutation(internal.webhooks.createEvent, {
          webhookId: webhook._id,
          token,
          workspaceId: webhook.workspaceId,
          actionId: webhook.actionId,
          payload,
          filterPrompt: webhook.filter,
          filterResult: filterResult.reason,
          filtered: true,
        });

        return new Response(
          JSON.stringify({ ok: false, filtered: true, reason: filterResult.reason }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Path 2 — Filter passes: store with filter context for observability
      await ctx.runMutation(internal.webhooks.createEvent, {
        webhookId: webhook._id,
        token,
        workspaceId: webhook.workspaceId,
        actionId: webhook.actionId,
        payload,
        filterPrompt: webhook.filter,
        filterResult: filterResult.reason,
      });
    } else {
      // Path 3 — No filter: bare event
      await ctx.runMutation(internal.webhooks.createEvent, {
        webhookId: webhook._id,
        token,
        workspaceId: webhook.workspaceId,
        actionId: webhook.actionId,
        payload,
      });
    }
```

- [ ] **Step 2: Verify Convex accepts the changes**

Run: `cd apps/backend && npx convex dev`
Expected: No errors. The HTTP handler compiles and deploys.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/convex/http.ts
git commit -m "feat: pass filterPrompt and filterResult for all webhook event paths"
```

---

### Task 4: Types & IPC Bridge

**Files:**
- Modify: `apps/desktop/src/shared/types.ts:300-305`
- Modify: `apps/desktop/src/preload/index.ts:248-263`

- [ ] **Step 1: Add `WebhookEventToast` type**

In `apps/desktop/src/shared/types.ts`, add the `WebhookEventToast` interface OUTSIDE the `ElectronAPI` interface — place it after the `ElectronAPI` closing `}` on line 305:

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

- [ ] **Step 2: Add `onWebhookEventNotification` to `ElectronAPI`**

In `apps/desktop/src/shared/types.ts`, add inside `ElectronAPI` after `onWebhookRunAction` (after line 304, before the closing `}` on line 305):

```ts
  onWebhookEventNotification: (callback: (data: WebhookEventToast) => void) => () => void
```

- [ ] **Step 3: Add preload bridge for `onWebhookEventNotification`**

In `apps/desktop/src/preload/index.ts`, add inside the `api` object before its closing `}` (before line 263), after the `onWebhookRunAction` block:

```ts
  onWebhookEventNotification: (callback: (data: import('../shared/types').WebhookEventToast) => void) => {
    const handler = (_event: any, data: import('../shared/types').WebhookEventToast) => callback(data)
    ipcRenderer.on('webhook-event-notification', handler)
    return () => { ipcRenderer.removeListener('webhook-event-notification', handler) }
  },
```

- [ ] **Step 4: Add to `removeAllListeners`**

In `apps/desktop/src/preload/index.ts`, add after line 150 (`ipcRenderer.removeAllListeners('webhook-run-action')`):

```ts
    ipcRenderer.removeAllListeners('webhook-event-notification')
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/types.ts apps/desktop/src/preload/index.ts
git commit -m "feat: add WebhookEventToast type and IPC bridge"
```

---

### Task 5: Desktop — Notification Polling

**Files:**
- Modify: `apps/desktop/src/main/webhook-listener.ts:22-25,148-190`

- [ ] **Step 1: Add notification state and interface**

In `apps/desktop/src/main/webhook-listener.ts`, add after line 25 (`let mainWindow`):

```ts
let lastNotifiedAt: number = Date.now()
```

Add after the existing `PendingEvent` interface (after line 157):

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
```

- [ ] **Step 2: Add `sendWebhookNotification` function**

Add before `pollAndProcess` (before line 159):

```ts
function sendWebhookNotification(event: WebhookEventNotification): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const data = loadPersistedData()
  const workspace = data.workspaces[event.workspaceId]
  const action = workspace?.customActions.find((a) => a.id === event.actionId)

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

- [ ] **Step 3: Add notification query to `pollAndProcess`**

In `pollAndProcess()`, add the dev-only notification query after the existing event processing loop (after the `for (const event of events)` block, before the `} catch (error) {` on what is currently line 184):

```ts
    // Dev-only: fetch recent events (all statuses) for toast notifications
    if (process.env.NODE_ENV !== 'production') {
      try {
        const recentEvents = (await convexQuery('webhooks:getRecentEventNotifications', {
          since: lastNotifiedAt,
        })) as WebhookEventNotification[] | null

        if (recentEvents && recentEvents.length > 0) {
          lastNotifiedAt = Math.max(...recentEvents.map((e) => e.createdAt))
          for (const event of recentEvents) {
            sendWebhookNotification(event)
          }
        }
      } catch (error) {
        console.error('[webhook-listener] Notification query failed:', error)
      }
    }
```

Note: `process.env.NODE_ENV` is `'development'` during `electron-vite dev` and `'production'` in packaged builds. This is consistent with the pattern used in `src/main/persistence.ts`.

- [ ] **Step 4: Verify the app starts and polls correctly**

Run: `cd apps/desktop && bun run dev`
Expected: App starts, `[webhook-listener]` logs show polling. No errors from notification query.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/webhook-listener.ts
git commit -m "feat: add dev-only webhook notification polling"
```

---

### Task 6: Renderer — Webhook Toast Component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/WebhookToast.tsx`

- [ ] **Step 1: Create the `WebhookToast.tsx` component**

Create `apps/desktop/src/renderer/src/components/WebhookToast.tsx`:

```tsx
import { useState } from 'react'
import { isLightColor } from '../utils/color'
import type { WebhookEventToast } from '../../../shared/types'

export interface WebhookToastEntry extends WebhookEventToast {
  id: string
  fadingOut: boolean
  expanded: boolean
}

interface WebhookToastContainerProps {
  toasts: WebhookToastEntry[]
  onDismiss: (id: string) => void
  onToggleExpand: (id: string) => void
}

export function WebhookToastContainer({ toasts, onDismiss, onToggleExpand }: WebhookToastContainerProps) {
  if (toasts.length === 0) return null

  return (
    <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none items-center">
      {toasts.map((t) => (
        <WebhookToastItem
          key={t.id}
          entry={t}
          onDismiss={() => onDismiss(t.id)}
          onToggleExpand={() => onToggleExpand(t.id)}
        />
      ))}
    </div>
  )
}

function WebhookToastItem({
  entry,
  onDismiss,
  onToggleExpand,
}: {
  entry: WebhookToastEntry
  onDismiss: () => void
  onToggleExpand: () => void
}) {
  const [copied, setCopied] = useState(false)
  const bg = entry.workspaceColor || '#1a1a2e'
  const light = isLightColor(bg)
  const textPrimary = light ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.9)'
  const textSecondary = light ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)'
  const borderColor = light ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.1)'
  const badgeColor = entry.filterPassed ? '#4ade80' : '#fbbf24'
  const badgeText = entry.filterPassed ? 'Triggered' : 'Filtered'
  const reasonText = entry.filterResult
    ? (entry.filterResult.length > 80 && !entry.expanded
      ? entry.filterResult.slice(0, 80) + '...'
      : entry.filterResult)
    : null

  const payloadStr = typeof entry.payload === 'string'
    ? entry.payload
    : JSON.stringify(entry.payload, null, 2)

  const handleCopyPayload = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(payloadStr ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className={`pointer-events-auto rounded-xl shadow-lg transition-all duration-300
        ${entry.fadingOut ? 'opacity-0 -translate-y-4' : 'opacity-100 translate-y-0 animate-toast-in'}`}
      style={{ backgroundColor: bg, border: `1px solid ${borderColor}`, maxWidth: '560px', minWidth: '340px' }}
    >
      {/* Collapsed header — always visible */}
      <button
        onClick={onToggleExpand}
        className="w-full flex items-center gap-3 px-4 py-3 cursor-pointer hover:brightness-110 transition-all"
      >
        {/* Workspace color dot */}
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: entry.workspaceColor }}
        />

        {/* Action name */}
        <span className="text-[13px] font-semibold truncate" style={{ color: textPrimary }}>
          {entry.actionName}
        </span>

        {/* Pass/fail badge */}
        <span
          className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
          style={{ backgroundColor: `${badgeColor}22`, color: badgeColor }}
        >
          {badgeText}
        </span>

        {/* LLM reason (truncated) */}
        {reasonText && (
          <span className="text-[11px] truncate ml-auto" style={{ color: textSecondary }}>
            {reasonText}
          </span>
        )}

        {/* Chevron */}
        <span
          className="text-[11px] shrink-0 transition-transform duration-200"
          style={{ color: textSecondary, transform: entry.expanded ? 'rotate(180deg)' : undefined }}
        >
          ▼
        </span>

        {/* Dismiss X */}
        <span
          onClick={(e) => { e.stopPropagation(); onDismiss() }}
          className="text-[11px] shrink-0 opacity-40 hover:opacity-100 transition-opacity ml-1"
          style={{ color: textPrimary }}
        >
          ✕
        </span>
      </button>

      {/* Expanded content */}
      {entry.expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3" style={{ borderTop: `1px solid ${borderColor}` }}>
          {/* Workspace info */}
          <div className="pt-3 flex items-center gap-2">
            <span className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: textSecondary }}>
              {entry.workspaceName}
            </span>
            <span className="text-[9px]" style={{ color: textSecondary }}>
              {new Date(entry.createdAt).toLocaleTimeString()}
            </span>
          </div>

          {/* Filter prompt */}
          {entry.filterPrompt && (
            <div>
              <span className="text-[9px] font-semibold uppercase tracking-wider block mb-1" style={{ color: textSecondary }}>
                Filter Prompt
              </span>
              <div
                className="text-[11px] font-mono leading-snug px-3 py-2 rounded-lg"
                style={{ color: textPrimary, backgroundColor: `${textPrimary}08`, border: `1px solid ${borderColor}` }}
              >
                {entry.filterPrompt}
              </div>
            </div>
          )}

          {/* LLM reasoning */}
          {entry.filterResult && (
            <div>
              <span className="text-[9px] font-semibold uppercase tracking-wider block mb-1" style={{ color: badgeColor }}>
                LLM Reasoning
              </span>
              <div className="text-[11px] leading-snug" style={{ color: textPrimary }}>
                {entry.filterResult}
              </div>
            </div>
          )}

          {/* Payload */}
          {entry.payload && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: textSecondary }}>
                  Payload
                </span>
                <button
                  onClick={handleCopyPayload}
                  className="text-[9px] font-mono px-1.5 py-0.5 rounded hover:brightness-125 transition-all cursor-pointer"
                  style={{ color: textSecondary, backgroundColor: `${textPrimary}08` }}
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <pre
                className="text-[10px] font-mono leading-snug px-3 py-2 rounded-lg overflow-auto whitespace-pre-wrap break-all"
                style={{
                  color: textPrimary,
                  backgroundColor: `${textPrimary}05`,
                  border: `1px solid ${borderColor}`,
                  maxHeight: '200px',
                }}
              >
                {payloadStr}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/WebhookToast.tsx
git commit -m "feat: add expandable WebhookToast component"
```

---

### Task 7: Renderer — Hook & App Integration

**Files:**
- Modify: `apps/desktop/src/renderer/src/hooks/useWebhooks.ts:1-19`
- Modify: `apps/desktop/src/renderer/src/App.tsx:15,32,273-278`

- [ ] **Step 1: Rewrite `useWebhooks` hook with toast state**

Replace the entire contents of `apps/desktop/src/renderer/src/hooks/useWebhooks.ts`:

```ts
import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore } from '../store/app-store'
import type { WebhookEventToast } from '../../../shared/types'
import type { WebhookToastEntry } from '../components/WebhookToast'

export function useWebhooks() {
  const [webhookToasts, setWebhookToasts] = useState<WebhookToastEntry[]>([])
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismissWebhookToast = useCallback((id: string) => {
    setWebhookToasts((prev) => prev.map((t) => (t.id === id ? { ...t, fadingOut: true } : t)))
    setTimeout(() => {
      setWebhookToasts((prev) => prev.filter((t) => t.id !== id))
    }, 300)
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const toggleWebhookToastExpand = useCallback((id: string) => {
    setWebhookToasts((prev) => prev.map((t) => (t.id === id ? { ...t, expanded: !t.expanded } : t)))
  }, [])

  useEffect(() => {
    const unsubRun = window.electronAPI.onWebhookRunAction(({ workspaceId, actionId }) => {
      const state = useAppStore.getState()
      const workspace = state.workspaces[workspaceId]
      if (!workspace) return
      const action = workspace.customActions.find((a) => a.id === actionId)
      if (!action) return
      state.runAction(workspaceId, action)
    })

    // Dev-only: webhook event notifications for toast display
    let unsubNotify: (() => void) | undefined
    if (import.meta.env.DEV) {
      unsubNotify = window.electronAPI.onWebhookEventNotification((data: WebhookEventToast) => {
        const id = crypto.randomUUID()
        setWebhookToasts((prev) => [...prev, { ...data, id, fadingOut: false, expanded: false }])
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

- [ ] **Step 2: Update `App.tsx` imports**

In `apps/desktop/src/renderer/src/App.tsx`, add the import (after line 15, the `useWebhooks` import):

```ts
import { WebhookToastContainer } from './components/WebhookToast'
```

- [ ] **Step 3: Update `App.tsx` hook usage**

In `apps/desktop/src/renderer/src/App.tsx`, replace line 32:

```ts
  useWebhooks()
```

with:

```ts
  const { webhookToasts, dismissWebhookToast, toggleWebhookToastExpand } = useWebhooks()
```

- [ ] **Step 4: Render `WebhookToastContainer`**

In `apps/desktop/src/renderer/src/App.tsx`, add after the existing `<ToastContainer>` block and before the `AutomationDebugOverlay` (after line 277):

```tsx
      {import.meta.env.DEV && (
        <WebhookToastContainer
          toasts={webhookToasts}
          onDismiss={dismissWebhookToast}
          onToggleExpand={toggleWebhookToastExpand}
        />
      )}
```

- [ ] **Step 5: Verify the app builds and renders**

Run: `cd apps/desktop && bun run dev`
Expected: App starts with no TypeScript errors. No toasts visible yet (no webhooks firing), but the component mounts without errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/useWebhooks.ts apps/desktop/src/renderer/src/components/WebhookToast.tsx apps/desktop/src/renderer/src/App.tsx
git commit -m "feat: integrate webhook toast notifications (dev-only)"
```

---

### Task 8: Manual Smoke Test

- [ ] **Step 1: Start the app in dev mode**

Run: `cd apps/desktop && bun run dev`

- [ ] **Step 2: Enable a webhook on an action with a filter**

In the app UI, create or select an action, enable its webhook, and set a plain-English filter (e.g., "Only trigger for PR merge events").

- [ ] **Step 3: Send a test webhook**

```bash
curl -X POST https://reminiscent-malamute-957.convex.site/webhook/<TOKEN> \
  -H "Content-Type: application/json" \
  -d '{"action": "opened", "pull_request": {"merged": false, "title": "test PR"}}'
```

Expected: Within ~5s, a toast appears showing:
- Action name + "Filtered" badge (since `merged: false`)
- Clicking the chevron expands to show the filter prompt, LLM reasoning, and payload JSON

- [ ] **Step 4: Send a matching webhook**

```bash
curl -X POST https://reminiscent-malamute-957.convex.site/webhook/<TOKEN> \
  -H "Content-Type: application/json" \
  -d '{"action": "closed", "pull_request": {"merged": true, "title": "test PR"}}'
```

Expected: Toast with "Triggered" badge. The action also executes in the terminal.

- [ ] **Step 5: Verify the toast auto-dismisses after 15 seconds**
