# iOS Web Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver push notifications to the installed iOS PWA (`apps/web`) when an agent session finishes/goes idle or needs input, reusing the desktop's existing notification decision and message.

**Architecture:** The desktop `idle-notifier` already decides when to notify and builds a human-readable message. At its two dispatch points we also call a new `remote-bridge` export which, gated on the Mac being idle ≥120s, fires a `remote.notify` Convex mutation. That mutation schedules a `"use node"` action that signs with VAPID (`web-push`) and POSTs to each stored subscription. The web app registers a service worker, subscribes on a user tap inside the installed PWA, and shows/handles the notification.

**Tech Stack:** Convex (mutations, `"use node"` actions, scheduler), `web-push`, Next.js 16 App Router (`app/manifest.ts`, metadata), service worker (`public/sw.js`), Electron `powerMonitor`, vitest (desktop), bun:test (backend).

## Global Constraints

- iOS Web Push requires: installed-to-Home-Screen PWA, `display: "standalone"` manifest, a root-scope service worker, and the permission prompt triggered by a **user gesture** inside the standalone PWA.
- Backend tests use `bun:test` and test **pure functions only** — there is no convex-test harness. Convex mutation/action wiring is verified via `bun run typecheck`.
- Desktop tests use `vitest` (run with `npx vitest run <file>`), mocking `electron`.
- The remote bridge is **inert** when `DEVICE_SECRET` is unset — every new bridge call must no-op in that case.
- Device-authed Convex functions use `requireDevice(secret)`; web-authed functions use `await requireToken(ctx, token)`. Reuse these exactly.
- Idle threshold default: `120` seconds. Triggers: session **idle/finished** and **needs input** (`requiresUserInput`). Do NOT change native macOS notification behavior — the idle gate applies ONLY to the web-push fan-out.
- Single user: every `pushSubscriptions` row belongs to the one signed-in user; no per-user fan-out.

---

## File Structure

- `apps/backend/convex/schema.ts` — add `pushSubscriptions` table (modify).
- `apps/backend/convex/push.ts` — pure helpers: `buildPushPayload`, `isExpiredPushError` (create).
- `apps/backend/convex/push.test.ts` — bun:test for the pure helpers (create).
- `apps/backend/convex/remote.ts` — add `subscribe`, `unsubscribe`, `notify` mutations + `pruneSubscription` internal mutation (modify).
- `apps/backend/convex/sendPush.ts` — `"use node"` `sendPush` internal action (create).
- `apps/backend/package.json` — add `web-push` + `@types/web-push` (modify).
- `apps/web/src/app/manifest.ts` — PWA manifest route (create).
- `apps/web/src/app/layout.tsx` — add `appleWebApp` / theme metadata (modify).
- `apps/web/public/sw.js` — service worker: `push` + `notificationclick` (create).
- `apps/web/public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` — icons from desktop (create).
- `apps/web/src/lib/push.ts` — pure `urlBase64ToUint8Array` + `isStandalone` helpers (create).
- `apps/web/src/lib/push.test.ts` — vitest for `urlBase64ToUint8Array` (create).
- `apps/web/src/hooks/usePushNotifications.ts` — SW registration + subscribe flow (create).
- `apps/web/src/components/EnableNotifications.tsx` — the user-gesture button + states (create).
- `apps/desktop/src/main/remote-bridge-notify.ts` — pure `shouldRemoteNotify` gate (create).
- `apps/desktop/src/main/remote-bridge-notify.test.ts` — vitest for the gate (create).
- `apps/desktop/src/main/remote-bridge.ts` — add `remoteBridgeNotify` export (modify).
- `apps/desktop/src/main/idle-notifier.ts` — call `remoteBridgeNotify` at both dispatch points (modify).
- `docs/superpowers/specs/2026-06-22-ios-web-push-notifications-design.md` — already written.

---

## Task 1: Backend — pure push helpers

**Files:**
- Create: `apps/backend/convex/push.ts`
- Test: `apps/backend/convex/push.test.ts`

**Interfaces:**
- Produces: `buildPushPayload({ title, body, sessionId, requiresUserInput }): string` (JSON string sent to the SW); `isExpiredPushError(statusCode: number): boolean` (true for 404/410).

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/convex/push.test.ts
import { describe, expect, it } from "bun:test";
import { buildPushPayload, isExpiredPushError } from "./push";

describe("buildPushPayload", () => {
  it("serializes the notification fields to JSON", () => {
    const json = buildPushPayload({
      title: "Fix the bug",
      body: "needs input",
      sessionId: "s1",
      requiresUserInput: true,
    });
    expect(JSON.parse(json)).toEqual({
      title: "Fix the bug",
      body: "needs input",
      sessionId: "s1",
      requiresUserInput: true,
    });
  });
});

describe("isExpiredPushError", () => {
  it("treats 404 and 410 as expired", () => {
    expect(isExpiredPushError(404)).toBe(true);
    expect(isExpiredPushError(410)).toBe(true);
  });
  it("treats other codes as not expired", () => {
    expect(isExpiredPushError(500)).toBe(false);
    expect(isExpiredPushError(201)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && bun test convex/push.test.ts`
Expected: FAIL — `Cannot find module "./push"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/backend/convex/push.ts
// Pure helpers for web-push fan-out. No Convex/Node imports here so they can be
// unit-tested with bun:test (the backend has no convex-test harness).

export interface PushNotificationInput {
  title: string;
  body: string;
  sessionId: string;
  requiresUserInput: boolean;
}

/** JSON payload delivered to the service worker's `push` handler. */
export function buildPushPayload(input: PushNotificationInput): string {
  return JSON.stringify({
    title: input.title,
    body: input.body,
    sessionId: input.sessionId,
    requiresUserInput: input.requiresUserInput,
  });
}

/** Push services return 404/410 for subscriptions that should be pruned. */
export function isExpiredPushError(statusCode: number): boolean {
  return statusCode === 404 || statusCode === 410;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && bun test convex/push.test.ts`
Expected: PASS (4 assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/convex/push.ts apps/backend/convex/push.test.ts
git commit -m "feat(backend): pure web-push payload + expiry helpers"
```

---

## Task 2: Backend — schema table + subscription mutations

**Files:**
- Modify: `apps/backend/convex/schema.ts`
- Modify: `apps/backend/convex/remote.ts`

**Interfaces:**
- Consumes: `requireToken(ctx, token)`, `requireDevice(secret)` (already in `remote.ts`).
- Produces (in `remote.ts`):
  - `subscribe` mutation — args `{ token, endpoint, p256dh, auth }`; upserts by `endpoint`.
  - `unsubscribe` mutation — args `{ token, endpoint }`; deletes by `endpoint`.
  - `pruneSubscription` internalMutation — args `{ endpoint }`; deletes by `endpoint` (called by the send action).

- [ ] **Step 1: Add the table to the schema**

In `apps/backend/convex/schema.ts`, add this table inside the `defineSchema({ ... })` object, after `ptyCommands`:

```ts
  // Web Push subscriptions for the installed PWA (iOS/Android/desktop browser).
  // Single user, so every row belongs to the signed-in user.
  pushSubscriptions: defineTable({
    token: v.string(),     // owning web auth session token
    endpoint: v.string(),  // push service endpoint (unique key)
    p256dh: v.string(),    // subscription.keys.p256dh
    auth: v.string(),      // subscription.keys.auth
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_endpoint", ["endpoint"]),
```

- [ ] **Step 2: Add the mutations to `remote.ts`**

At the end of `apps/backend/convex/remote.ts`, add:

```ts
// ── Web Push subscriptions ────────────────────────────────────────────────

export const subscribe = mutation({
  args: { token: v.string(), endpoint: v.string(), p256dh: v.string(), auth: v.string() },
  handler: async (ctx, { token, endpoint, p256dh, auth }) => {
    await requireToken(ctx, token);
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { token, p256dh, auth });
    } else {
      await ctx.db.insert("pushSubscriptions", {
        token, endpoint, p256dh, auth, createdAt: Date.now(),
      });
    }
  },
});

export const unsubscribe = mutation({
  args: { token: v.string(), endpoint: v.string() },
  handler: async (ctx, { token, endpoint }) => {
    await requireToken(ctx, token);
    const row = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .unique();
    if (row) await ctx.db.delete(row._id);
  },
});

export const pruneSubscription = internalMutation({
  args: { endpoint: v.string() },
  handler: async (ctx, { endpoint }) => {
    const row = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .unique();
    if (row) await ctx.db.delete(row._id);
  },
});
```

`internalMutation` is already imported at the top of `remote.ts` — confirm the import line reads `import { mutation, query, internalMutation, QueryCtx, MutationCtx } from "./_generated/server";` and add `internalMutation` if missing.

- [ ] **Step 3: Verify it typechecks**

Run: `cd apps/backend && bun run typecheck`
Expected: PASS (no errors). The generated `_generated` types update on `convex dev`; if typecheck complains about missing `pushSubscriptions` in the data model, run `npx convex codegen` first, then re-run typecheck.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/convex/schema.ts apps/backend/convex/remote.ts
git commit -m "feat(backend): pushSubscriptions table + subscribe/unsubscribe/prune"
```

---

## Task 3: Backend — notify mutation + sendPush action

**Files:**
- Modify: `apps/backend/package.json`
- Modify: `apps/backend/convex/remote.ts`
- Create: `apps/backend/convex/sendPush.ts`

**Interfaces:**
- Consumes: `requireDevice(secret)`; `buildPushPayload`, `isExpiredPushError` from `./push`; `internal.sendPush.sendPush`, `internal.remote.pruneSubscription`.
- Produces:
  - `remote.notify` mutation — args `{ secret, title, body, sessionId, requiresUserInput }`; schedules the send action.
  - `sendPush.sendPush` internalAction (`"use node"`) — args `{ title, body, sessionId, requiresUserInput }`; signs with VAPID and POSTs to every subscription, pruning expired ones.

- [ ] **Step 1: Add the dependency**

Run:
```bash
cd apps/backend && bun add web-push && bun add -d @types/web-push
```
Expected: `web-push` appears in `dependencies` and `@types/web-push` in `devDependencies` of `apps/backend/package.json`.

- [ ] **Step 2: Add the `notify` mutation to `remote.ts`**

After the `pruneSubscription` block in `apps/backend/convex/remote.ts`, add:

```ts
import { internal } from "./_generated/api";

export const notify = mutation({
  args: {
    secret: v.string(),
    title: v.string(),
    body: v.string(),
    sessionId: v.string(),
    requiresUserInput: v.boolean(),
  },
  handler: async (ctx, { secret, title, body, sessionId, requiresUserInput }) => {
    requireDevice(secret);
    await ctx.scheduler.runAfter(0, internal.sendPush.sendPush, {
      title, body, sessionId, requiresUserInput,
    });
  },
});
```

Place the `import { internal } from "./_generated/api";` line with the other imports at the top of the file (do not duplicate if already present).

- [ ] **Step 3: Create the send action**

```ts
// apps/backend/convex/sendPush.ts
"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import webpush from "web-push";
import { buildPushPayload, isExpiredPushError } from "./push";

export const sendPush = internalAction({
  args: {
    title: v.string(),
    body: v.string(),
    sessionId: v.string(),
    requiresUserInput: v.boolean(),
  },
  handler: async (ctx, { title, body, sessionId, requiresUserInput }) => {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT;
    if (!publicKey || !privateKey || !subject) {
      console.warn("[sendPush] VAPID env not configured — skipping");
      return;
    }
    webpush.setVapidDetails(subject, publicKey, privateKey);

    const payload = buildPushPayload({ title, body, sessionId, requiresUserInput });
    const subs = await ctx.runQuery(internal.sendPush.allSubscriptions, {});

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
      } catch (err: any) {
        const status = err?.statusCode ?? 0;
        if (isExpiredPushError(status)) {
          await ctx.runMutation(internal.remote.pruneSubscription, { endpoint: sub.endpoint });
        } else {
          console.warn("[sendPush] send failed:", status, err?.message);
        }
      }
    }
  },
});

export const allSubscriptions = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query("pushSubscriptions").collect(),
});
```

Add `internalQuery` to the import: `import { internalAction, internalQuery } from "./_generated/server";`. (A `"use node"` file may export a query alongside the action; if codegen rejects mixing, move `allSubscriptions` into `remote.ts` as an `internalQuery` and reference `internal.remote.allSubscriptions` instead — prefer this fallback if typecheck fails.)

- [ ] **Step 4: Verify it typechecks**

Run: `cd apps/backend && npx convex codegen && bun run typecheck`
Expected: PASS. If the mixed action/query export errors, apply the fallback noted in Step 3 and re-run.

- [ ] **Step 5: Verify pure helpers still pass**

Run: `cd apps/backend && bun test convex/push.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/package.json apps/backend/bun.lock apps/backend/convex/remote.ts apps/backend/convex/sendPush.ts
git commit -m "feat(backend): remote.notify mutation + VAPID web-push send action"
```

---

## Task 4: Web — PWA manifest, icons, service worker

**Files:**
- Create: `apps/web/src/app/manifest.ts`
- Modify: `apps/web/src/app/layout.tsx`
- Create: `apps/web/public/sw.js`
- Create: `apps/web/public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`

**Interfaces:**
- Produces: a registered service worker at `/sw.js` handling `push` and `notificationclick`; a standalone manifest at `/manifest.webmanifest`.

- [ ] **Step 1: Generate icons from the desktop app icon**

Find the desktop icon (PNG, ideally ≥512px):
```bash
ls apps/desktop/build/ apps/desktop/resources/ 2>/dev/null | grep -iE "icon|png"
```
Copy/resize a 512 and 192 PNG into `apps/web/public/` as `icon-512.png`, `icon-192.png`, and `icon-maskable-512.png` (the maskable copy can be the same 512 image). Use `sips` on macOS:
```bash
sips -z 512 512 <source.png> --out apps/web/public/icon-512.png
sips -z 192 192 <source.png> --out apps/web/public/icon-192.png
cp apps/web/public/icon-512.png apps/web/public/icon-maskable-512.png
```
If no suitable source exists, ask the user for a 512px PNG before proceeding.

- [ ] **Step 2: Create the manifest route**

```ts
// apps/web/src/app/manifest.ts
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Orchestra Web",
    short_name: "Orchestra",
    description: "Remote client for Orchestra — control your workspaces and terminal sessions.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
```

- [ ] **Step 3: Add Apple PWA + theme metadata to layout**

In `apps/web/src/app/layout.tsx`, extend the exported `metadata` object and add a `viewport` export:

```ts
export const metadata: Metadata = {
  title: "Orchestra Web",
  description: "Remote client for Orchestra — control your workspaces and terminal sessions.",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Orchestra" },
};

export const viewport = { themeColor: "#0a0a0a" };
```
Add `import type { Metadata } from "next";` already exists — keep it.

- [ ] **Step 4: Create the service worker**

```js
// apps/web/public/sw.js
// Service worker for Orchestra Web push notifications.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "Orchestra";
  const body = data.body || "";
  const sessionId = data.sessionId || null;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { sessionId },
      tag: sessionId || undefined,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = all.find((c) => "focus" in c);
      if (client) {
        await client.focus();
        client.postMessage({ type: "attach-session", sessionId });
      } else {
        await self.clients.openWindow("/?session=" + encodeURIComponent(sessionId || ""));
      }
    })(),
  );
});
```

- [ ] **Step 5: Verify build**

Run: `cd apps/web && bun run build`
Expected: build succeeds; `.next` output lists `/manifest.webmanifest` as a route. (`public/sw.js` is served statically at `/sw.js`.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/manifest.ts apps/web/src/app/layout.tsx apps/web/public/sw.js apps/web/public/icon-192.png apps/web/public/icon-512.png apps/web/public/icon-maskable-512.png
git commit -m "feat(web): PWA manifest, icons, and push service worker"
```

---

## Task 5: Web — push helpers + subscribe flow UI

**Files:**
- Create: `apps/web/src/lib/push.ts`
- Create: `apps/web/src/lib/push.test.ts`
- Create: `apps/web/src/hooks/usePushNotifications.ts`
- Create: `apps/web/src/components/EnableNotifications.tsx`

**Interfaces:**
- Consumes: `anyApi.remote.subscribe` / `anyApi.remote.unsubscribe` (Task 2); `NEXT_PUBLIC_VAPID_PUBLIC_KEY` env.
- Produces: `urlBase64ToUint8Array(base64: string): Uint8Array`; `isStandalone(): boolean`; `usePushNotifications(token: string)` hook returning `{ status, enable }`; `<EnableNotifications token={token} />` component.

- [ ] **Step 1: Write the failing test for the pure helper**

```ts
// apps/web/src/lib/push.test.ts
import { describe, expect, it } from "vitest";
import { urlBase64ToUint8Array } from "./push";

describe("urlBase64ToUint8Array", () => {
  it("decodes url-safe base64 to the right byte length", () => {
    // "hello" base64url = "aGVsbG8"
    const bytes = urlBase64ToUint8Array("aGVsbG8");
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/push.test.ts`
Expected: FAIL — cannot find `urlBase64ToUint8Array`. (If vitest is not installed in `apps/web`, add it: `bun add -d vitest`, then re-run.)

- [ ] **Step 3: Implement the helpers**

```ts
// apps/web/src/lib/push.ts

/** Convert a VAPID public key (base64url) to the Uint8Array applicationServerKey. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

/** True when running as an installed standalone PWA (iOS Safari or others). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone;
  return iosStandalone === true || window.matchMedia("(display-mode: standalone)").matches;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/push.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the hook**

```ts
// apps/web/src/hooks/usePushNotifications.ts
'use client'
import { useCallback, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { anyApi } from "convex/server";
import { urlBase64ToUint8Array, isStandalone } from "../lib/push";

type Status = "unsupported" | "not-installed" | "default" | "granted" | "denied";

export function usePushNotifications(token: string) {
  const [status, setStatus] = useState<Status>("default");
  const subscribe = useMutation(anyApi.remote.subscribe);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatus("unsupported");
      return;
    }
    if (!isStandalone()) {
      setStatus("not-installed");
      return;
    }
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    setStatus(Notification.permission as Status);

    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === "attach-session" && e.data.sessionId) {
        window.dispatchEvent(new CustomEvent("attach-session", { detail: e.data.sessionId }));
      }
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, []);

  const enable = useCallback(async () => {
    const permission = await Notification.requestPermission();
    setStatus(permission as Status);
    if (permission !== "granted") return;

    const reg = await navigator.serviceWorker.ready;
    const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!key) {
      console.warn("NEXT_PUBLIC_VAPID_PUBLIC_KEY not set");
      return;
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
    const json = sub.toJSON();
    await subscribe({
      token,
      endpoint: json.endpoint!,
      p256dh: json.keys!.p256dh,
      auth: json.keys!.auth,
    });
  }, [token, subscribe]);

  return { status, enable };
}
```

- [ ] **Step 6: Implement the button component**

```tsx
// apps/web/src/components/EnableNotifications.tsx
'use client'
import { usePushNotifications } from "../hooks/usePushNotifications";
import { Button } from "@/components/ui/button";

export function EnableNotifications({ token }: { token: string }) {
  const { status, enable } = usePushNotifications(token);

  if (status === "unsupported") return null;
  if (status === "granted") return null;
  if (status === "not-installed") {
    return <p className="text-xs text-muted-foreground px-2">Add to Home Screen to enable notifications.</p>;
  }
  if (status === "denied") {
    return <p className="text-xs text-muted-foreground px-2">Notifications blocked in Settings.</p>;
  }
  return (
    <Button size="sm" variant="outline" onClick={() => void enable()}>
      Enable notifications
    </Button>
  );
}
```
If `@/components/ui/button` does not exist, check `apps/web/src/components/ui/` for the actual button export and adjust the import; otherwise use a plain `<button className="...">`.

- [ ] **Step 7: Mount the component**

In `apps/web/src/app/page.tsx`, render `<EnableNotifications token={token} />` inside `RemoteApp` (e.g. in the sidebar/header area near the existing controls). Add the import at the top:
```ts
import { EnableNotifications } from '../components/EnableNotifications'
```

- [ ] **Step 8: Verify build + tests**

Run: `cd apps/web && npx vitest run src/lib/push.test.ts && bun run typecheck && bun run build`
Expected: tests PASS, typecheck PASS, build succeeds.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/push.ts apps/web/src/lib/push.test.ts apps/web/src/hooks/usePushNotifications.ts apps/web/src/components/EnableNotifications.tsx apps/web/src/app/page.tsx
git commit -m "feat(web): subscribe flow + enable-notifications UI"
```

---

## Task 6: Desktop — idle gate + remote-bridge notify

**Files:**
- Create: `apps/desktop/src/main/remote-bridge-notify.ts`
- Create: `apps/desktop/src/main/remote-bridge-notify.test.ts`
- Modify: `apps/desktop/src/main/remote-bridge.ts`
- Modify: `apps/desktop/src/main/idle-notifier.ts`

**Interfaces:**
- Consumes: `anyApi.remote.notify` (Task 3); `getClient()`, `isEnabled()`, `DEVICE_SECRET` (in `remote-bridge.ts`); Electron `powerMonitor`.
- Produces:
  - `shouldRemoteNotify(idleSeconds: number, thresholdSeconds: number): boolean` (pure).
  - `remoteBridgeNotify(input: { title: string; body: string; sessionId: string; requiresUserInput: boolean }): void` — no-op when bridge disabled; otherwise gated by `getSystemIdleTime()` ≥ threshold, then fires `remote.notify`.

- [ ] **Step 1: Write the failing test for the gate**

```ts
// apps/desktop/src/main/remote-bridge-notify.test.ts
import { describe, expect, it } from 'vitest'
import { shouldRemoteNotify, IDLE_THRESHOLD_SECONDS } from './remote-bridge-notify'

describe('shouldRemoteNotify', () => {
  it('pushes when idle at or above the threshold', () => {
    expect(shouldRemoteNotify(IDLE_THRESHOLD_SECONDS, IDLE_THRESHOLD_SECONDS)).toBe(true)
    expect(shouldRemoteNotify(IDLE_THRESHOLD_SECONDS + 10, IDLE_THRESHOLD_SECONDS)).toBe(true)
  })
  it('suppresses when idle below the threshold', () => {
    expect(shouldRemoteNotify(0, IDLE_THRESHOLD_SECONDS)).toBe(false)
    expect(shouldRemoteNotify(IDLE_THRESHOLD_SECONDS - 1, IDLE_THRESHOLD_SECONDS)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/remote-bridge-notify.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement the gate (pure) + the dispatcher**

```ts
// apps/desktop/src/main/remote-bridge-notify.ts
import { powerMonitor } from 'electron'
import { anyApi } from 'convex/server'
import { DEVICE_SECRET } from './convex-config'
import { getRemoteClient, isRemoteBridgeEnabled } from './remote-bridge'

/** Seconds the Mac must be idle before phone pushes fire. */
export const IDLE_THRESHOLD_SECONDS = 120

/** Pure gate: only push to the phone once the user is away from the Mac. */
export function shouldRemoteNotify(idleSeconds: number, thresholdSeconds: number): boolean {
  return idleSeconds >= thresholdSeconds
}

export interface RemoteNotifyInput {
  title: string
  body: string
  sessionId: string
  requiresUserInput: boolean
}

/** Fire a web push for an idle/needs-input event. No-op when the bridge is
 *  disabled or the user is actively at the Mac. Never throws into the caller. */
export function remoteBridgeNotify(input: RemoteNotifyInput): void {
  if (!isRemoteBridgeEnabled()) return
  const idle = powerMonitor.getSystemIdleTime()
  if (!shouldRemoteNotify(idle, IDLE_THRESHOLD_SECONDS)) return
  void getRemoteClient()
    .mutation(anyApi.remote.notify, { secret: DEVICE_SECRET, ...input })
    .catch((err: unknown) => console.warn('[remote-bridge] notify failed:', err))
}
```

- [ ] **Step 4: Export the bridge accessors from `remote-bridge.ts`**

In `apps/desktop/src/main/remote-bridge.ts`, the helpers `isEnabled()` and `getClient()` are module-private. Export thin public wrappers (do NOT rename the existing privates) by adding near them:

```ts
export function isRemoteBridgeEnabled(): boolean {
  return isEnabled()
}

export function getRemoteClient(): ConvexClient {
  return getClient()
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/remote-bridge-notify.test.ts`
Expected: PASS. (The test imports only the pure `shouldRemoteNotify`; the `electron`/bridge imports are not executed by these assertions. If vitest tries to resolve `electron` at import time and fails, add `vi.mock('electron', () => ({ powerMonitor: { getSystemIdleTime: () => 0 } }))` at the top of the test file, matching the mock style in `idle-notifier-interruption.test.ts`.)

- [ ] **Step 6: Hook the dispatcher into `idle-notifier.ts` (needs-input path)**

In `apps/desktop/src/main/idle-notifier.ts`, add the import near the top:
```ts
import { remoteBridgeNotify } from './remote-bridge-notify'
```
In `notifyTerminalAttention`, after the existing `mainWindow.webContents.send('idle-notification', {...})` call, add:
```ts
  remoteBridgeNotify({
    sessionId,
    title: sessionTitle,
    body: description?.trim() || resolvedTitle,
    requiresUserInput: true,
  })
```

- [ ] **Step 7: Hook the dispatcher into `idle-notifier.ts` (idle-finished path)**

In `notifyIdleTransition`, after the immediate `mainWindow.webContents.send('idle-notification', {...})` dispatch (the one built from `summary`/`sessionTitle`), add:
```ts
  remoteBridgeNotify({
    sessionId,
    title: sessionTitle,
    body: requiresUserInput ? 'Needs your input' : 'Finished',
    requiresUserInput,
  })
```
Use the `sessionTitle` and `requiresUserInput` variables already computed in that function.

- [ ] **Step 8: Verify typecheck + desktop tests**

Run: `cd apps/desktop && bun run typecheck && npx vitest run src/main/remote-bridge-notify.test.ts src/main/idle-notifier-interruption.test.ts`
Expected: typecheck PASS; both test files PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/main/remote-bridge-notify.ts apps/desktop/src/main/remote-bridge-notify.test.ts apps/desktop/src/main/remote-bridge.ts apps/desktop/src/main/idle-notifier.ts
git commit -m "feat(desktop): fan out idle/needs-input notifications to web push when away"
```

---

## Task 7: Config + manual verification

**Files:**
- Modify: `apps/web/.env.production` (and `.env.local` for dev) — add `NEXT_PUBLIC_VAPID_PUBLIC_KEY`.
- No code; this task wires env and validates end-to-end on a real iPhone.

**Interfaces:**
- Consumes: everything from Tasks 1–6.

- [ ] **Step 1: Generate VAPID keys**

Run:
```bash
cd apps/backend && npx web-push generate-vapid-keys
```
Copy the printed `Public Key` and `Private Key`.

- [ ] **Step 2: Set Convex env**

Run (replace placeholders):
```bash
cd apps/backend
npx convex env set VAPID_PUBLIC_KEY "<public-key>"
npx convex env set VAPID_PRIVATE_KEY "<private-key>"
npx convex env set VAPID_SUBJECT "mailto:you@example.com"
```
For the production deployment, repeat with `--prod`.

- [ ] **Step 3: Set the web public key**

Add to `apps/web/.env.production` (and `.env.local` for local dev) and to the Vercel project env:
```
NEXT_PUBLIC_VAPID_PUBLIC_KEY=<public-key>
```
Then redeploy the web app so the client bundle includes it.

- [ ] **Step 4: Manual end-to-end test on iPhone**

Web Push cannot be exercised reliably in CI/simulator — verify on a real device:
1. Open the deployed web URL in Safari on iPhone, sign in.
2. Share → **Add to Home Screen**. Open the installed app.
3. Tap **Enable notifications** → grant permission.
4. On the Mac, start an agent session, then leave the Mac untouched for ≥120s.
5. Trigger an idle/finish or a needs-input prompt.
6. Confirm the push arrives on the phone (app closed). Tap it → app opens and attaches to that session.
7. Verify that when the Mac is actively in use (idle <120s), no phone push is sent while the native macOS notification still fires.

- [ ] **Step 5: Commit env wiring**

```bash
git add apps/web/.env.production
git commit -m "chore(web): add VAPID public key env for push notifications"
```

---

## Self-Review

**Spec coverage:**
- PWA scaffold (manifest/SW/icons/register) → Task 4, Task 5. ✓
- Subscription storage + mutations → Task 2. ✓
- `remote.notify` + `"use node"` send action + VAPID → Task 3. ✓
- Desktop hook at idle-notifier dispatch points + idle gate (`getSystemIdleTime` ≥120s) → Task 6. ✓
- Config (VAPID Convex/Vercel) → Task 7. ✓
- Triggers idle/finished + needs-input → Task 6 Steps 6–7. ✓
- Error handling (bridge disabled no-op, prune 404/410, per-endpoint isolation) → Task 1 (`isExpiredPushError`), Task 3 (sendPush try/catch + prune), Task 6 (`remoteBridgeNotify` enabled-guard). ✓
- Testing approach (pure unit tests + manual iOS) → Tasks 1, 5, 6 unit tests; Task 7 manual. ✓

**Type consistency:** `buildPushPayload`/`isExpiredPushError` (Task 1) consumed in Task 3; `subscribe`/`unsubscribe`/`pruneSubscription` signatures (Task 2) consumed in Tasks 3 & 5; `remote.notify` args (Task 3) match `remoteBridgeNotify` payload spread (Task 6); `urlBase64ToUint8Array`/`isStandalone` (Task 5) consumed by the hook. Consistent. ✓

**Placeholder scan:** No TBD/TODO; every code step has full code. ✓
