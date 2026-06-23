# iOS Web Push Notifications for Orchestra Web

**Date:** 2026-06-22
**Status:** Approved (design)
**Author:** brainstorming session

## Problem

Orchestra Web (`apps/web`, Next.js on Vercel) is used as a remote client, added to
the iPhone Home Screen. The desktop app fires native notifications when an agent
session goes idle/finishes or needs user input. The web client has no equivalent —
the user must keep the tab open and look at it. We want the installed iOS PWA to
receive push notifications for the same events, even when the app is closed.

iOS supports Web Push since 16.4, but **only** for a PWA installed to the Home
Screen, and only after the app has a valid manifest + service worker, and only when
the permission prompt is triggered by a user gesture from inside the installed PWA.

## Goals

- Push to the installed iOS PWA when an agent session:
  - **finished / went idle**, or
  - **needs input / permission** (the desktop's `requiresUserInput` signal).
- Reuse the desktop's existing notification *decision* and human-readable message,
  so web push semantics match the native desktop notifications.
- Only push when the user is actually away from the Mac (system idle ≥ threshold),
  to avoid double-notifying while they're at the desktop.

## Non-goals

- Webhook (Linear/GitHub) push notifications — out of scope for this pass.
- Android/desktop-browser push (the architecture is platform-agnostic and will work
  there too, but iOS is the target we validate).
- Per-session / per-workspace notification preferences — YAGNI for v1.

## Architecture

Reuse the desktop's notification decision rather than re-deriving triggers in the
backend. The desktop already decides *when* to notify and crafts the message (via
the OpenRouter classifier/summarizer in `idle-notifier`). We hook that same dispatch
point to also emit the event to Convex, which fans it out as a Web Push.

```
desktop idle-notifier ──(title, body, sessionId, requiresUserInput)──▶ remote-bridge
        │ (same event that fires the native macOS notification)
        │ gate: powerMonitor.getSystemIdleTime() >= IDLE_THRESHOLD_SECONDS
        ▼
   Convex remote.notify  (auth: DEVICE_SECRET)
        │  reads pushSubscriptions, schedules send action
        ▼
   Convex sendPush  ("use node" action: web-push + VAPID)
        │  POST to each subscription endpoint; prune 404/410
        ▼
   Apple Push  ──▶  iOS PWA service worker (push event)  ──▶  Notification shown
                                                          └─ tap → focus/open app,
                                                                   navigate to session
```

**Why reuse the desktop decision (vs. backend-derived from `liveStatus`):** the
"needs input / permission" signal only exists in the desktop's LLM classifier
(`detectRequiresUserInput`); the backend's `liveStatus` only carries
`idle`/`working`/`exited`. Reusing the desktop decision captures both chosen triggers
and a human-readable message for free, with semantics identical to the native
notifications the user already trusts. The cost — push only works while the desktop
app is running — is inherent: sessions only exist when the desktop runs.

## Components

### 1. PWA scaffold — `apps/web`

`apps/web` is not currently a real PWA (no manifest, service worker, or icons). This
is the prerequisite.

- **`src/app/manifest.ts`** — Next 16 metadata route returning a manifest with
  `display: "standalone"`, `name`, `short_name`, `theme_color`, `background_color`,
  `start_url`, and `icons`.
- **Icons** — 192×192 and 512×512 PNGs plus a maskable variant, derived from the
  Orchestra desktop app icon. Served from `public/`.
- **`public/sw.js`** — service worker at root scope (required by iOS). Handlers:
  - `push`: parse JSON payload `{title, body, sessionId, requiresUserInput}` and call
    `self.registration.showNotification(title, { body, data: { sessionId }, … })`.
  - `notificationclick`: focus an existing client or `clients.openWindow('/')`, then
    postMessage the `sessionId` so the app attaches to that session (mirrors the
    desktop `navigate-to-session` behavior).
- **Client registration hook** (`src/hooks/usePushNotifications.ts` or similar):
  - Register `/sw.js` on mount.
  - Expose an explicit "Enable notifications" action. On a **user tap** (iOS
    requires a gesture, and only inside the installed standalone PWA): call
    `Notification.requestPermission()`, then `registration.pushManager.subscribe`
    with `applicationServerKey = NEXT_PUBLIC_VAPID_PUBLIC_KEY`, then send the
    subscription to Convex via the `subscribe` mutation.
  - Detect standalone/installed mode (`navigator.standalone` / display-mode media
    query) to show appropriate guidance ("Add to Home Screen first") when not
    installed.

### 2. Subscription storage — `apps/backend/convex`

New table in `schema.ts`:

```ts
pushSubscriptions: defineTable({
  token: v.string(),          // owning web auth session token
  endpoint: v.string(),       // push service endpoint (unique key)
  p256dh: v.string(),         // subscription.keys.p256dh
  auth: v.string(),           // subscription.keys.auth
  createdAt: v.number(),
})
  .index("by_token", ["token"])
  .index("by_endpoint", ["endpoint"]),
```

Mutations (in `remote.ts`, authed by existing session `token` via `requireToken`):

- `subscribe({ token, endpoint, p256dh, auth })` — upsert by `endpoint`.
- `unsubscribe({ token, endpoint })` — delete by `endpoint`.

Single user, so every subscription belongs to them; no per-user fan-out logic needed.

### 3. Send — `apps/backend/convex`

- **`remote.notify`** mutation — args `{ secret, title, body, sessionId,
  requiresUserInput }`, authed via `requireDevice(secret)` (reuses `DEVICE_SECRET`).
  Schedules the send action via `ctx.scheduler.runAfter(0, …)`.
- **`sendPush`** internal action with `"use node"` — loads all
  `pushSubscriptions`, uses the `web-push` library with VAPID keys to POST the
  payload to each endpoint. On `404`/`410` responses, schedule/perform deletion of
  that subscription (actions can't write directly — call an internal mutation
  `pruneSubscription({ endpoint })`).

Payload sent to the SW: `JSON.stringify({ title, body, sessionId, requiresUserInput })`.

### 4. Desktop hook — `apps/desktop`

At the existing notification dispatch point in `src/main/idle-notifier.ts` (where
the native `Notification` is shown / `idle-notification` IPC is sent), also call a
new `remote-bridge` export, e.g. `remoteBridgeNotify({ title, body, sessionId,
requiresUserInput })`.

Gate inside that hook (or in the notifier before calling it):

```ts
import { powerMonitor } from 'electron'
const IDLE_THRESHOLD_SECONDS = 120
if (powerMonitor.getSystemIdleTime() >= IDLE_THRESHOLD_SECONDS) {
  remoteBridgeNotify({ … })   // fires Convex remote.notify (no-op if bridge disabled)
}
```

`remoteBridgeNotify` is a no-op when the bridge is disabled (no `DEVICE_SECRET`).
The native macOS notification behavior is unchanged; the idle gate applies **only**
to the web-push fan-out.

### 5. Config — env

- Generate keys once: `npx web-push generate-vapid-keys`.
- **Convex env:** `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`
  (`mailto:` or site URL).
- **Vercel env:** `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (same public key; exposed to client).

## Data flow (happy path)

1. User installs PWA to Home Screen, opens it, taps "Enable notifications", grants
   permission → subscription stored in `pushSubscriptions` via `subscribe`.
2. An agent session goes idle / needs input. Desktop `idle-notifier` builds the
   message and shows the native notification as today.
3. If `getSystemIdleTime() >= 120s`, the bridge calls `remote.notify`.
4. `remote.notify` schedules `sendPush`, which signs with VAPID and POSTs to the
   user's subscription endpoint(s).
5. iOS delivers the push; the service worker `push` handler shows the notification.
6. User taps it → app opens/focuses and attaches to `sessionId`.

## Error handling

- **Bridge disabled / no `DEVICE_SECRET`:** `remoteBridgeNotify` is a no-op.
- **No subscriptions:** `sendPush` iterates an empty set; no-op.
- **Expired/invalid subscription (404/410):** pruned via `pruneSubscription`.
- **Other push errors:** logged and skipped per-endpoint; one bad endpoint does not
  block the others.
- **Permission denied on client:** surface a message; do not retry automatically.
- **Not installed / not standalone:** client shows "Add to Home Screen" guidance and
  does not attempt to subscribe.

## Testing

- **Backend:** unit-test `subscribe`/`unsubscribe` upsert + auth (extend
  `remoteAuth.test.ts` style); test `remote.notify` rejects bad `secret`; test
  `pruneSubscription` removes by endpoint. Mock `web-push` in the action test.
- **Desktop:** unit-test the idle-gate decision (mock `powerMonitor.getSystemIdleTime`)
  — pushes when idle ≥ threshold, suppressed when below; `remoteBridgeNotify` no-op
  when disabled.
- **Web:** manual on a real iPhone (Web Push cannot be exercised in CI/simulator
  reliably) — install to Home Screen, enable, trigger an idle event, confirm push +
  tap-to-attach. Smoke-test SW registration and the subscribe payload shape in a
  desktop browser.

## Open items / future

- Per-session mute / notification preferences.
- Webhook-event pushes.
- Badge counts (`navigator.setAppBadge`) for unread attention items.
- Make `IDLE_THRESHOLD_SECONDS` user-configurable in settings.
