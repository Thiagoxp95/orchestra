# Design: Orchestra Web — Terminal-First Remote Client (v1)

Date: 2026-06-22
Status: Approved (pending spec review)

## Overview

A browser-based client ("Orchestra Web", `apps/web`) that lets the user view and
control their Orchestra desktop terminal sessions from anywhere — phone or any
browser — while the desktop app and its daemon run on their home machine. The
web app is a **thin remote client**: it owns no terminal state. The daemon
remains the single source of truth for PTYs; the Electron **main** process
bridges that state to/from **Convex** (the already-live, authenticated cloud
channel); the browser talks only to Convex.

This replaces the current "hack" of auto-injecting the `/remote-control` slash
command into every blank Claude session. (Removing that injection is a
follow-up, not part of this build — see Out of Scope.)

### Constraints (locked with product owner)

- **Single user, single machine.** No multi-device or multi-tenant support.
- **Auth:** Convex Auth with the Password provider. Email + password come from
  environment variables. **Sign-in only — no signup.**
- **Always-on bridge.** The bridge runs whenever the desktop app is launched
  (no opt-in flag). Workspace/tree/session *state* is mirrored continuously so
  the web sidebar is an exact live mirror of Orchestra Electron.
- **Terminal renderer:** `xterm.js` in the browser (same family as desktop).
- **v1 is terminal-first:** browse workspaces → trees → sessions; attach to any
  live session (read live output, type input, resize, send agent controls).
  Everything else is read-only or out of scope.

## Current architecture (for reference)

```
Renderer (React) ──IPC──▶ Main (Electron) ──Unix socket / NDJSON──▶ Daemon (owns all PTYs)
                              │
                              └──WebSocket──▶ Convex (apps/backend — live channel, webhooks today)
```

- Daemon (`apps/desktop/src/daemon`) owns PTYs, survives app close, listens on a
  Unix domain socket. Exposes `createOrAttach`, `write`, `resize`, `kill`,
  `listSessions`, `getSnapshot` (`SessionSnapshot { snapshotAnsi,
  rehydrateSequences, cwd, cols, rows }`), etc. **No changes in v1.**
- Main (`apps/desktop/src/main`) holds the live `ConvexClient`
  (`webhook-listener.ts`, `convex-config.ts`), the persisted workspace/session
  store (`persistence.ts` → `loadPersistedData()` / `saveWorkspaces()`), and the
  `DaemonClient` (`daemon-client.ts`). Terminal output flows
  `daemon → main → renderer` via `webContents.send('terminal-data', sessionId,
  data)`; live status via `claude-work-state`, `session-label-update`,
  `terminal-exit`.
- Persisted state shape (`shared/types.ts`): `Workspace { id, name, color,
  emoji?, trees: WorkspaceTree[], activeTreeIndex, customActions, linearConfig?,
  ... }`, `WorkspaceTree { rootDir, sessionIds[], displayName? }`,
  `TerminalSession { id, workspaceId, label, processStatus, cwd, actionId?, ... }`.
- `apps/web` (Next.js 16) and `apps/mobile` exist as empty scaffolds.
- Shared agent controls live in `shared/agent-controls.ts` (`resolveSendSteps`,
  control definitions per provider) — reused by the web for Enter/Esc/interrupt.

## Target architecture

```
Browser (apps/web — Next.js + xterm.js, mobile-friendly)
   │   Convex React client · auth: email+pass from env, sign-in only
   ▼
Convex (apps/backend)
   remoteState  — sanitized workspace/tree/session tree + live status (1 reactive doc)
   ptyChunks    — batched terminal output, append-only, seq-ordered, TTL-pruned
   ptyCommands  — write / resize / kill / control · attach / detach (web → bridge)
   ▲
   │   Convex WS (existing client) + new remote-bridge module
Electron main (apps/desktop)
   • mirrors persisted workspace/session state → remoteState (secrets stripped)
   • taps daemon terminal-data → batches ~50ms → appends ptyChunks (attached session only)
   • subscribes ptyCommands → forwards to daemon-client (write/resize/kill/controls)
   ▼   Unix socket (unchanged)
Daemon (owns all PTYs — NO changes)
```

---

## Component 1 — Convex layer (`apps/backend/convex`)

### Auth (`auth.ts`, `auth.config.ts`)

- Add `@convex-dev/auth` configured with the **Password** provider only.
- A single user is seeded from Convex deployment env vars `REMOTE_EMAIL` and
  `REMOTE_PASSWORD` via a one-time internal mutation / seed script
  (`convex/seedUser.ts`, run manually once per deployment).
- **No signup surface:** the web renders a sign-in form only. As defense in
  depth, the Password provider's `profile`/validation rejects any email other
  than `REMOTE_EMAIL`, so even a crafted signup request cannot create a second
  account.
- The **desktop bridge authenticates headlessly** with the same
  `REMOTE_EMAIL` / `REMOTE_PASSWORD` (loaded from the desktop `.env` via the
  existing `MAIN_VITE_`-prefixed env mechanism, new vars
  `MAIN_VITE_REMOTE_EMAIL` / `MAIN_VITE_REMOTE_PASSWORD`). Bridge and browser
  therefore act as the one user; all queries/mutations are scoped to that
  identity.

### Schema (`schema.ts`, additive)

```ts
// One reactive document mirroring the desktop's workspace structure + live status.
remoteState: defineTable({
  // sanitized: NO linearConfig.apiKey, NO encrypted secrets
  workspaces: v.any(),     // Workspace[] minus secrets (see sanitization below)
  sessions: v.any(),       // Record<sessionId, { label, processStatus, cwd, workspaceId, actionIcon? }>
  liveStatus: v.any(),     // Record<sessionId, { work: 'idle'|'working', exited?: boolean, label?: string }>
  activeWorkspaceId: v.union(v.string(), v.null()),
  activeSessionId: v.union(v.string(), v.null()),
  updatedAt: v.number(),
}),  // single row; bridge upserts. (No index needed — singleton.)

// Append-only batched terminal output for the attached session.
ptyChunks: defineTable({
  sessionId: v.string(),
  seq: v.number(),         // monotonic per session, assigned by bridge
  data: v.string(),        // base64 of raw PTY bytes — avoids corrupting multibyte
                           // UTF-8 / ANSI sequences split across batch boundaries;
                           // web base64-decodes and feeds bytes to xterm.write()
  createdAt: v.number(),
}).index("by_session_seq", ["sessionId", "seq"])
  .index("by_created", ["createdAt"]),

// Commands from web → bridge.
ptyCommands: defineTable({
  sessionId: v.string(),   // '' for non-session commands if any
  kind: v.union(
    v.literal("write"), v.literal("resize"), v.literal("kill"),
    v.literal("control"), v.literal("attach"), v.literal("detach"),
  ),
  payload: v.any(),        // write: {data}; resize: {cols,rows}; control: {provider, controlId}; attach/detach: {}
  createdAt: v.number(),
}).index("by_created", ["createdAt"]),
```

### Functions (`remote.ts`)

- `getRemoteState` (query) — returns the singleton `remoteState` row. Auth-gated.
- `pushRemoteState` (mutation, bridge-only) — upsert the singleton.
- `getChunks` (query) — args `{ sessionId, afterSeq }`; returns chunks with
  `seq > afterSeq` ordered by seq. Web subscribes; applies in order.
- `appendChunk` (mutation, bridge-only) — `{ sessionId, seq, data }`.
- `sendCommand` (mutation, web) — inserts a `ptyCommands` row
  (`write`/`resize`/`kill`/`control`/`attach`/`detach`).
- `claimCommands` (query + delete pattern) — bridge subscribes to `ptyCommands`
  ordered by `createdAt`, applies, then deletes each consumed row (delete =
  consume; no `consumed` flag needed since single consumer).

### Crons (`crons.ts`, extend)

- Add a frequent prune (e.g. every 5 min) deleting `ptyChunks` older than a
  short TTL (e.g. 2 min) — only the active session's recent tail matters; the
  snapshot seed covers history. Also delete orphaned `ptyCommands` older than
  ~60 s as a safety net.

### Attach semantics (cost control)

`remoteState` (sidebar/status) is mirrored **always**. The high-frequency
`ptyChunks` byte stream is produced **only for the session the web has
`attach`-ed** (one at a time). On `attach`, the bridge seeds the first chunk
from `daemonClient.getSnapshot(sessionId)` so the terminal renders identically
to Electron the instant it opens, then streams live output until `detach` (or
attach to a different session).

---

## Component 2 — Main-process remote bridge (`apps/desktop/src/main/remote-bridge.ts`)

A new module started during app startup (alongside `startWebhookListener`),
**always-on**. Responsibilities:

1. **Connect & authenticate.** Reuse a `ConvexClient` (`CONVEX_CLOUD_URL`).
   Sign in headlessly with `MAIN_VITE_REMOTE_EMAIL` / `MAIN_VITE_REMOTE_PASSWORD`.
   If the env vars are absent (e.g. a dev without remote configured), log and
   no-op — the bridge is inert, desktop behaves exactly as today.

2. **State out (continuous).** Hook the existing persist path: whenever the
   renderer persists workspaces (the IPC that calls `saveWorkspaces`), the
   bridge also builds a **sanitized snapshot** and calls `pushRemoteState`.
   Sanitization (critical — never leak secrets to the cloud):
   - Drop `Workspace.linearConfig.apiKey` (and any encrypted/`safeStorage`
     fields). Keep only what the web needs: workspace id/name/color/emoji,
     `trees[].{rootDir, displayName, sessionIds}`, `activeTreeIndex`, and a
     minimal session map (`label`, `processStatus`, `cwd`, `workspaceId`,
     `actionIcon`). Explicitly allow-list fields rather than block-list.
   Also mirror live status as it changes: subscribe to the same
   `claude-work-state`, `session-label-update`, `terminal-exit` signals the
   daemon-client emits, and patch `remoteState.liveStatus`.

3. **Output relay (attached session).** Add an **output tap** to
   `daemon-client.ts`: a small `EventEmitter` (or callback registry) that fires
   alongside the existing `webContents.send('terminal-data', …)`. The bridge
   subscribes; for the currently-attached session it batches data (flush every
   ~50 ms or when buffered ≥ N KB), assigns the next per-session `seq`, and
   calls `appendChunk`. Non-attached sessions are ignored (no writes).

4. **Input relay.** Subscribe to `ptyCommands` (via `claimCommands`). For each:
   - `attach` → record attached session; call `daemonClient.getSnapshot`,
     append it as the seed chunk; reset seq baseline.
   - `detach` → clear attached session.
   - `write` → `daemonClient.write(sessionId, data)`.
   - `resize` → `daemonClient.resize(sessionId, cols, rows)`.
   - `kill` → `daemonClient.kill(sessionId)`.
   - `control` → resolve via shared `agent-controls` (`resolveSendSteps`) and
     write the resulting sequences.
   Delete the row after applying.

### Files touched (desktop)

- `apps/desktop/src/main/remote-bridge.ts` — new module (the bridge).
- `apps/desktop/src/main/daemon-client.ts` — add an output-tap emitter (a few
  lines next to the existing `terminal-data` send; no behavior change to
  renderer path) and re-emit status signals the bridge can subscribe to.
- App startup wiring (where `startWebhookListener` is invoked) — start the
  bridge.
- The persist IPC handler — invoke `remoteBridge.onStatePersisted(data)` after
  `saveWorkspaces`.
- `convex-config.ts` / env.d.ts — add the two new `MAIN_VITE_REMOTE_*` env vars.

No daemon changes. No renderer UI changes.

---

## Component 3 — Web app (`apps/web`, Next.js)

- **Providers/auth.** Add `convex/react` `ConvexProvider` + `@convex-dev/auth`
  client. A sign-in page (email + password) gates the app; no signup link.
- **Sidebar.** Subscribe to `getRemoteState`; render workspaces → trees →
  sessions with live status badges (working/idle/exited, labels). Layout tuned
  for phone width.
- **Terminal pane.** `xterm.js`. On selecting a session:
  1. `sendCommand({kind:'attach', sessionId})`.
  2. Subscribe to `getChunks({sessionId, afterSeq})`; base64-decode and
     `xterm.write()` each chunk's bytes in `seq` order, tracking `afterSeq`. The
     seed (snapshot) chunk renders the current screen immediately.
  3. Keyboard input → `sendCommand({kind:'write', payload:{data}})`.
  4. Terminal resize (fit addon) → `sendCommand({kind:'resize', payload:{cols,rows}})`.
  5. On unmount / switching → `sendCommand({kind:'detach'})`.
- **Agent controls.** On-screen buttons (Enter / Esc / interrupt and the
  provider's defined controls) reuse the shared `agent-controls` definitions →
  `sendCommand({kind:'control', payload:{provider, controlId}})`.

### Files (web)

- `apps/web/src/app/` — auth gate + main layout (sidebar + terminal).
- `apps/web/src/components/Sidebar.tsx`, `Terminal.tsx`, `AgentControls.tsx`.
- `apps/web/src/lib/convex.ts` — client setup.
- Add deps: `convex`, `@convex-dev/auth`, `@xterm/xterm`, `@xterm/addon-fit`.

---

## Data flow summary

- **Sidebar mirror:** desktop persist → `pushRemoteState` → web `getRemoteState`
  (always live).
- **Open a session:** web `attach` → bridge snapshot seed + live tap on →
  `appendChunk` → web `getChunks` → xterm.
- **Type:** web `write` → `ptyCommands` → bridge → `daemonClient.write` → daemon
  → output loops back through the chunk path.

## Latency / cost mitigations

- Only the attached session streams bytes; one attach at a time.
- Output batched ~50 ms / size threshold.
- `ptyChunks` short TTL + frequent cron prune; snapshot seed avoids storing
  long history.
- Web tracks `afterSeq` so subscriptions stay bounded to the recent tail.

## Error handling

- Bridge: if Convex auth fails or env vars missing → log + inert; desktop
  unaffected. Reconnect on WS drop (mirror existing webhook-listener behavior).
- Web: if `getRemoteState` is empty (desktop offline) → "Desktop not connected"
  state. Chunk seq gap → request a fresh `attach` (re-seed).
- Commands are best-effort; `kill`/`resize` are idempotent enough to retry.

## Testing

- **Convex** (`apps/backend`, bun test): command insert/claim/delete; chunk
  seq-ordering query; **state sanitization strips `linearConfig.apiKey` and any
  secret fields**; auth rejects non-allowed email.
- **Bridge:** output batching (timer + size flush), command→daemon mapping
  table, attached-session gating (non-attached sessions produce no chunks),
  sanitization allow-list.
- **Web:** chunk application with out-of-order / gapped seqs; attach/detach
  lifecycle; control-button → command mapping.
- **Manual e2e:** open web on phone, see live sidebar mirror, attach to a
  running Claude session, read output, type a prompt, send Esc/interrupt.

## Out of scope (YAGNI for v1)

- Multiple machines / multiple users / multi-device attach.
- Worktree creation/cleanup, diff view, issue board, settings editing, voice.
- Launching/killing sessions from web beyond the `kill` command (no
  custom-action launch flow in v1).
- Offline command queueing, push notifications.
- **Removing the `/remote-control` auto-injection** in `action-utils.ts` —
  separate follow-up once Web supersedes it.

## Verification

- Sidebar on web matches Electron's workspaces/trees/sessions and updates live
  as sessions change state.
- Attaching to a session renders the current screen instantly (snapshot) then
  streams live output; typing reaches the agent; Enter/Esc/interrupt work.
- No secret (Linear API key) ever appears in any Convex table.
- With remote env vars unset, desktop runs exactly as before (bridge inert).
