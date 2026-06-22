# Web Remote Actions Bar — Design

**Date:** 2026-06-22
**Status:** Approved

## Goal

Surface the desktop's per-workspace custom actions (the icon row in the
desktop NavBar) inside the Orchestra web remote control, as a
horizontally-scrollable icon bar below the `AgentKeyBar` keyboard. Tapping an
action runs it on the desktop exactly like clicking it in the NavBar, and the
web view auto-attaches to the newly spawned session.

## Layout

New component `apps/web/src/components/ActionBar.tsx`, rendered inside
`TerminalPane` directly below `AgentKeyBar` (so it sits under the "extra
commands" keyboard, matching the mockup).

- One round icon button per action, using the existing `DynamicIcon` so
  `__claude__` / `__openai__` / hugeicons render identically to desktop.
- `overflow-x-auto` flex row, `shrink-0` buttons, touch momentum scroll.
- No "+" add-action button (creating actions stays a desktop concern).
- Renders only when the active workspace has ≥1 custom action. Because it lives
  in `TerminalPane`, it is only visible while a session is open (as in the
  mockup).

## Data flow (4 layers)

1. **Sanitize** (`apps/desktop/src/main/remote-bridge-sanitize.ts`): add
   `customActions: { id: string; name: string; icon: string }[]` to
   `SafeWorkspace`, allow-listing only those three fields — never `command`,
   `webhookToken`, `webhookUrl`, or other sensitive fields. Mirrored
   automatically via the existing `pushState`.

2. **Convex** (`apps/backend/convex/remote.ts`): add `"runAction"` to the
   `sendCommand` kind union. `sessionId` is unused for this kind (pass `""`);
   `payload` carries `{ workspaceId, actionId }`.

3. **Bridge** (`apps/desktop/src/main/remote-bridge.ts`, main process):
   `startRemoteBridge(mainWindow)` gains the `BrowserWindow` handle (call site
   in `index.ts` already has it in scope). `applyOne` handles `"runAction"` by
   `mainWindow.webContents.send('remote-run-action', { workspaceId, actionId })`.

4. **Renderer**: new preload method `onRemoteRunAction` (clone of
   `onWebhookRunAction`) plus a small `useRemoteActions` hook (wired alongside
   `useWebhooks`) that looks up the action and calls
   `runAction(workspaceId, action)` with **default opts** — active tree, focus
   on creation — so it behaves like a NavBar tap (the webhook path forces
   `forceDefaultTree`, which we do not want here).

## Auto-attach

`runAction` focuses the new session → desktop `activeSessionId` updates →
mirrors back via `pushState`. In `apps/web/src/app/page.tsx`: firing an action
opens a short-lived "pending attach" window (~8s); an effect watching
`remoteState.activeSessionId` switches `selected` to it once it changes within
that window. The window-gating prevents the desktop user's own session switches
from hijacking the web view.

The web sends the `runAction` command from `ActionBar` (it has `token`); the
fire callback also notifies `page.tsx` to open the pending-attach window.

## Testing

- Unit: `sanitizeWorkspaces` includes `customActions` and excludes secret fields.
- Unit: `applyOne` routes `"runAction"` to a `webContents.send` spy with the
  correct channel and payload.
- Web: `ActionBar` renders one button per action and invokes its fire callback
  on click.

## Out of scope

- Creating/editing actions from the web.
- Background/automation-only actions behave the same as a NavBar tap (whatever
  `runAction` already does for `runInBackground`); no special remote handling.
