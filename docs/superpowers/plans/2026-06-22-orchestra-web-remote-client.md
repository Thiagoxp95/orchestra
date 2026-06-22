# Orchestra Web — Terminal-First Remote Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser client that mirrors Orchestra Electron's workspaces/sessions and lets the user attach to, read, and type into any live terminal session from anywhere, relayed through Convex.

**Architecture:** The Electron **main** process runs an always-on "remote bridge" that mirrors sanitized workspace/session state into Convex and relays PTY I/O for the one session the web has attached. The browser (`apps/web`) talks only to Convex — reactive queries render the sidebar and stream terminal output; mutations send input. The daemon is unchanged.

**Tech Stack:** Convex (backend + relay), Electron main (TypeScript, `convex/browser` `ConvexClient`), Next.js 16 + React 19 + Tailwind 4 + `@xterm/xterm` (web), Vitest (desktop tests), `bun test` (backend/web pure-logic tests).

## Global Constraints

- Package manager is **bun** (`bun@1.3.0`). Install deps with `bun add` in the relevant `apps/*` dir.
- **Single user, single machine.** No multi-device/multi-tenant logic.
- **Auth:** custom Convex token scheme. Web sign-in compares against Convex env vars `REMOTE_EMAIL` / `REMOTE_PASSWORD`; returns a session token stored in `authSessions`. **No signup.** The desktop bridge authenticates with Convex env var `DEVICE_SECRET` (exposed to the desktop as `MAIN_VITE_DEVICE_SECRET`).
- **Terminal output chunks are stored as plain UTF-8 strings** (the data is already a decoded JS string at the main-process tap; batching is lossless string concatenation). No base64.
- **Agent controls in v1 are raw byte writes** (`write` command): Enter `\r`, Escape `\x1b`, Ctrl-C `\x03`, Up `\x1b[A`, Down `\x1b[B`. No dependency on `shared/agent-controls`.
- **Only the attached session streams `ptyChunks`** (one attached session at a time). `remoteState` (sidebar/status) mirrors continuously.
- **Never mirror secrets to Convex** — sanitize workspaces with an explicit allow-list (drop `linearConfig`, any encrypted fields).
- Convex functions: import `query`/`mutation`/`action` from `./_generated/server`, `v` from `convex/values`. `Math.random`/`Date.now`/`crypto` are only allowed in **actions**, not queries/mutations.
- Desktop unit tests run from `apps/desktop` via `npx vitest run <file>`. Backend/web pure-logic tests run via `bun test <file>` from that app dir.
- Commit after every task. Branch off `main` — do not commit directly to `main`; create branch `feat/orchestra-web-remote` first.

---

## File Structure

**Backend (`apps/backend/convex`)**
- `schema.ts` — MODIFY: add `remoteState`, `ptyChunks`, `ptyCommands`, `authSessions` tables.
- `remoteAuth.ts` — CREATE: `checkCredentials` (pure), `signIn` (action), `requireToken`/`requireDevice` helpers.
- `remoteAuth.test.ts` — CREATE: pure credential-check tests.
- `remote.ts` — CREATE: state + pty queries/mutations.
- `crons.ts` — MODIFY: add chunk/command prune.

**Desktop (`apps/desktop/src`)**
- `main/daemon-client.ts` — MODIFY: add `setTerminalDataTap`.
- `main/remote-bridge-sanitize.ts` — CREATE: pure `sanitizeWorkspaces`, `buildSessionMap`.
- `main/remote-bridge-sanitize.test.ts` — CREATE.
- `main/remote-bridge-batcher.ts` — CREATE: pure `createOutputBatcher`.
- `main/remote-bridge-batcher.test.ts` — CREATE.
- `main/remote-bridge.ts` — CREATE: the bridge (connect/auth/mirror/relay/commands).
- `main/index.ts` — MODIFY: start bridge, hook `save-state`.
- `main/convex-config.ts` — MODIFY: export `DEVICE_SECRET`.
- `main/env.d.ts` — MODIFY: declare new env var.

**Web (`apps/web`)**
- `src/lib/convexClient.ts` — CREATE: Convex client + token storage.
- `src/lib/chunk-buffer.ts` — CREATE: pure ordering reducer.
- `src/lib/chunk-buffer.test.ts` — CREATE.
- `src/lib/useAuth.ts` — CREATE: token state hook.
- `src/components/SignIn.tsx` — CREATE.
- `src/components/Sidebar.tsx` — CREATE.
- `src/components/Terminal.tsx` — CREATE.
- `src/app/page.tsx` — MODIFY: compose auth → sidebar + terminal.
- `src/app/layout.tsx` — MODIFY: providers.
- `.env.local` — CREATE: `NEXT_PUBLIC_CONVEX_URL`.

---

## Phase A — Convex backend

### Task 1: Schema tables

**Files:**
- Modify: `apps/backend/convex/schema.ts`

**Interfaces:**
- Produces: tables `authSessions` (index `by_token`), `remoteState` (singleton), `ptyChunks` (index `by_session_seq`, `by_created`), `ptyCommands` (index `by_created`).

- [ ] **Step 1: Add the tables**

Add these inside the `defineSchema({ ... })` object in `schema.ts`, after the existing `issues` table:

```ts
  // ── Orchestra Web remote client ───────────────────────────────────────

  // Web session tokens minted by signIn (single user, but allow multiple
  // browser sessions). Validated on every web query/mutation.
  authSessions: defineTable({
    token: v.string(),
    createdAt: v.number(),
  }).index("by_token", ["token"]),

  // Singleton: sanitized mirror of the desktop's workspace/session state.
  remoteState: defineTable({
    workspaces: v.any(),       // sanitized Workspace[] (no secrets)
    sessions: v.any(),         // Record<sessionId, {label,processStatus,cwd,workspaceId,actionIcon?}>
    liveStatus: v.any(),       // Record<sessionId, {work:'idle'|'working', exited?:boolean, label?:string}>
    activeWorkspaceId: v.union(v.string(), v.null()),
    activeSessionId: v.union(v.string(), v.null()),
    updatedAt: v.number(),
  }),

  // Batched terminal output for the attached session (append-only).
  ptyChunks: defineTable({
    sessionId: v.string(),
    seq: v.number(),
    data: v.string(),          // plain decoded terminal text
    createdAt: v.number(),
  })
    .index("by_session_seq", ["sessionId", "seq"])
    .index("by_created", ["createdAt"]),

  // Commands from web → bridge.
  ptyCommands: defineTable({
    sessionId: v.string(),
    kind: v.union(
      v.literal("write"),
      v.literal("resize"),
      v.literal("kill"),
      v.literal("attach"),
      v.literal("detach"),
    ),
    payload: v.any(),          // write:{data}; resize:{cols,rows}; others:{}
    createdAt: v.number(),
  }).index("by_created", ["createdAt"]),
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/backend && npx convex codegen && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS (no type errors). `convex codegen` regenerates `_generated/`.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/convex/schema.ts apps/backend/convex/_generated
git commit -m "feat(backend): add remote-client schema tables"
```

---

### Task 2: Auth — credential check + signIn + guards

**Files:**
- Create: `apps/backend/convex/remoteAuth.ts`
- Test: `apps/backend/convex/remoteAuth.test.ts`

**Interfaces:**
- Consumes: `authSessions` table (Task 1), env vars `REMOTE_EMAIL`, `REMOTE_PASSWORD`, `DEVICE_SECRET`.
- Produces:
  - `checkCredentials(email: string, password: string, envEmail: string | undefined, envPassword: string | undefined): boolean` (pure)
  - `signIn` action — args `{ email: string, password: string }` → returns `{ token: string } | { error: string }`.
  - `requireToken(ctx, token: string): Promise<void>` — throws `"unauthorized"` if token not in `authSessions`.
  - `requireDevice(secret: string): void` — throws `"unauthorized"` if `secret !== process.env.DEVICE_SECRET`.
  - internal mutation `storeSession` — args `{ token: string }`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/convex/remoteAuth.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { checkCredentials } from "./remoteAuth";

describe("checkCredentials", () => {
  it("accepts an exact email+password match", () => {
    expect(checkCredentials("me@x.com", "pw", "me@x.com", "pw")).toBe(true);
  });
  it("rejects a wrong password", () => {
    expect(checkCredentials("me@x.com", "nope", "me@x.com", "pw")).toBe(false);
  });
  it("rejects a wrong email", () => {
    expect(checkCredentials("other@x.com", "pw", "me@x.com", "pw")).toBe(false);
  });
  it("is case-insensitive on email, exact on password", () => {
    expect(checkCredentials("ME@X.com", "pw", "me@x.com", "pw")).toBe(true);
    expect(checkCredentials("me@x.com", "PW", "me@x.com", "pw")).toBe(false);
  });
  it("rejects when env is unset", () => {
    expect(checkCredentials("me@x.com", "pw", undefined, undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && bun test convex/remoteAuth.test.ts`
Expected: FAIL — `checkCredentials` not exported.

- [ ] **Step 3: Write the implementation**

Create `apps/backend/convex/remoteAuth.ts`:

```ts
import { action, mutation, QueryCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/** Pure credential check. Email case-insensitive; password exact. */
export function checkCredentials(
  email: string,
  password: string,
  envEmail: string | undefined,
  envPassword: string | undefined,
): boolean {
  if (!envEmail || !envPassword) return false;
  return email.trim().toLowerCase() === envEmail.trim().toLowerCase() && password === envPassword;
}

/** Web sign-in: validate against env, mint a token. Action (needs crypto). */
export const signIn = action({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, { email, password }) => {
    if (!checkCredentials(email, password, process.env.REMOTE_EMAIL, process.env.REMOTE_PASSWORD)) {
      return { error: "Invalid credentials" } as const;
    }
    const token = crypto.randomUUID() + crypto.randomUUID();
    await ctx.runMutation(internal.remoteAuth.storeSession, { token });
    return { token } as const;
  },
});

export const storeSession = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await ctx.db.insert("authSessions", { token, createdAt: Date.now() });
  },
});

/** Throws if the web token is not a known session. */
export async function requireToken(ctx: QueryCtx | MutationCtx, token: string): Promise<void> {
  const row = await ctx.db
    .query("authSessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!row) throw new Error("unauthorized");
}

/** Throws if the bridge device secret is wrong. */
export function requireDevice(secret: string): void {
  if (!process.env.DEVICE_SECRET || secret !== process.env.DEVICE_SECRET) {
    throw new Error("unauthorized");
  }
}
```

> Note: `storeSession` is exported as a normal `mutation` but referenced via
> `internal.remoteAuth.storeSession`. Mark it internal by importing
> `internalMutation` instead if you prefer; using `mutation` + `internal.` ref
> works because Convex resolves by name. To keep it truly internal, change
> `mutation` → `internalMutation` (import from `./_generated/server`) and the
> `internal.remoteAuth.storeSession` ref stays valid.

Use `internalMutation`:

```ts
import { action, internalMutation, QueryCtx, MutationCtx } from "./_generated/server";
// ...
export const storeSession = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await ctx.db.insert("authSessions", { token, createdAt: Date.now() });
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && bun test convex/remoteAuth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `cd apps/backend && npx convex codegen && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/convex/remoteAuth.ts apps/backend/convex/remoteAuth.test.ts apps/backend/convex/_generated
git commit -m "feat(backend): remote-client auth (env credentials + token guards)"
```

---

### Task 3: Remote state functions

**Files:**
- Create: `apps/backend/convex/remote.ts`

**Interfaces:**
- Consumes: `requireToken`, `requireDevice` (Task 2); `remoteState` table.
- Produces:
  - `pushRemoteState` (mutation) — args `{ secret, workspaces, sessions, liveStatus, activeWorkspaceId, activeSessionId }`. Upserts the singleton.
  - `getRemoteState` (query) — args `{ token }`. Returns the singleton row or `null`.

- [ ] **Step 1: Write the implementation**

Create `apps/backend/convex/remote.ts`:

```ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireToken, requireDevice } from "./remoteAuth";

// ── State mirror (bridge writes, web reads) ───────────────────────────────

export const pushRemoteState = mutation({
  args: {
    secret: v.string(),
    workspaces: v.any(),
    sessions: v.any(),
    liveStatus: v.any(),
    activeWorkspaceId: v.union(v.string(), v.null()),
    activeSessionId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    requireDevice(args.secret);
    const existing = await ctx.db.query("remoteState").first();
    const patch = {
      workspaces: args.workspaces,
      sessions: args.sessions,
      liveStatus: args.liveStatus,
      activeWorkspaceId: args.activeWorkspaceId,
      activeSessionId: args.activeSessionId,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("remoteState", patch);
    }
  },
});

export const getRemoteState = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireToken(ctx, token);
    return await ctx.db.query("remoteState").first();
  },
});
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/backend && npx convex codegen && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/convex/remote.ts apps/backend/convex/_generated
git commit -m "feat(backend): remoteState push/get functions"
```

---

### Task 4: PTY chunk + command functions

**Files:**
- Modify: `apps/backend/convex/remote.ts`

**Interfaces:**
- Consumes: `requireToken`, `requireDevice`; `ptyChunks`, `ptyCommands` tables.
- Produces:
  - `appendChunk` (mutation) — `{ secret, sessionId, seq, data }`.
  - `clearChunks` (mutation) — `{ secret, sessionId }` — deletes all chunks for a session (called on attach).
  - `getChunks` (query) — `{ token, sessionId, afterSeq }` → chunks with `seq > afterSeq`, ordered by seq asc.
  - `sendCommand` (mutation) — `{ token, sessionId, kind, payload }`.
  - `pendingCommands` (query) — `{ secret }` → all `ptyCommands` ordered by `createdAt` asc.
  - `deleteCommand` (mutation) — `{ secret, id }`.

- [ ] **Step 1: Append the functions**

Add to the end of `apps/backend/convex/remote.ts`:

```ts
// ── PTY output chunks (bridge writes, web reads) ──────────────────────────

export const appendChunk = mutation({
  args: { secret: v.string(), sessionId: v.string(), seq: v.number(), data: v.string() },
  handler: async (ctx, { secret, sessionId, seq, data }) => {
    requireDevice(secret);
    await ctx.db.insert("ptyChunks", { sessionId, seq, data, createdAt: Date.now() });
  },
});

export const clearChunks = mutation({
  args: { secret: v.string(), sessionId: v.string() },
  handler: async (ctx, { secret, sessionId }) => {
    requireDevice(secret);
    const rows = await ctx.db
      .query("ptyChunks")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
  },
});

export const getChunks = query({
  args: { token: v.string(), sessionId: v.string(), afterSeq: v.number() },
  handler: async (ctx, { token, sessionId, afterSeq }) => {
    await requireToken(ctx, token);
    return await ctx.db
      .query("ptyChunks")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId).gt("seq", afterSeq))
      .order("asc")
      .take(500);
  },
});

// ── Commands (web writes, bridge reads) ───────────────────────────────────

export const sendCommand = mutation({
  args: {
    token: v.string(),
    sessionId: v.string(),
    kind: v.union(
      v.literal("write"),
      v.literal("resize"),
      v.literal("kill"),
      v.literal("attach"),
      v.literal("detach"),
    ),
    payload: v.any(),
  },
  handler: async (ctx, { token, sessionId, kind, payload }) => {
    await requireToken(ctx, token);
    await ctx.db.insert("ptyCommands", { sessionId, kind, payload, createdAt: Date.now() });
  },
});

export const pendingCommands = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireDevice(secret);
    return await ctx.db.query("ptyCommands").withIndex("by_created").order("asc").take(200);
  },
});

export const deleteCommand = mutation({
  args: { secret: v.string(), id: v.id("ptyCommands") },
  handler: async (ctx, { secret, id }) => {
    requireDevice(secret);
    await ctx.db.delete(id);
  },
});
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/backend && npx convex codegen && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/convex/remote.ts apps/backend/convex/_generated
git commit -m "feat(backend): pty chunk + command functions"
```

---

### Task 5: Prune cron

**Files:**
- Modify: `apps/backend/convex/crons.ts`
- Modify: `apps/backend/convex/remote.ts` (add internal prune mutation)

**Interfaces:**
- Produces: `internalMutation` `pruneRemote` in `remote.ts`; a cron entry calling it.

- [ ] **Step 1: Add the prune mutation**

Add to `apps/backend/convex/remote.ts` (add `internalMutation` to the imports from `./_generated/server`):

```ts
import { internalMutation } from "./_generated/server";

// Delete terminal chunks older than 2 min and stray commands older than 60s.
export const pruneRemote = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const chunkCutoff = now - 2 * 60_000;
    const cmdCutoff = now - 60_000;
    const oldChunks = await ctx.db
      .query("ptyChunks")
      .withIndex("by_created", (q) => q.lt("createdAt", chunkCutoff))
      .take(1000);
    for (const c of oldChunks) await ctx.db.delete(c._id);
    const oldCmds = await ctx.db
      .query("ptyCommands")
      .withIndex("by_created", (q) => q.lt("createdAt", cmdCutoff))
      .take(1000);
    for (const c of oldCmds) await ctx.db.delete(c._id);
  },
});
```

- [ ] **Step 2: Register the cron**

Modify `apps/backend/convex/crons.ts` — add before `export default crons;`:

```ts
crons.interval(
  "prune remote pty data",
  { minutes: 5 },
  internal.remote.pruneRemote,
);
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/backend && npx convex codegen && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 4: Set Convex env vars + deploy**

Run (replace values; do these once per deployment):
```bash
cd apps/backend
npx convex env set REMOTE_EMAIL "you@example.com"
npx convex env set REMOTE_PASSWORD "a-strong-password"
npx convex env set DEVICE_SECRET "$(openssl rand -hex 32)"
npx convex deploy
```
Expected: deploy succeeds; functions appear in the dashboard. Record the `DEVICE_SECRET` value — it's reused as `MAIN_VITE_DEVICE_SECRET` (Task 10) and the web needs none of it.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/convex/crons.ts apps/backend/convex/remote.ts apps/backend/convex/_generated
git commit -m "feat(backend): prune cron for remote pty data"
```

---

## Phase B — Desktop bridge

### Task 6: daemon-client output tap

**Files:**
- Modify: `apps/desktop/src/main/daemon-client.ts`

**Interfaces:**
- Produces: `DaemonClient.setTerminalDataTap(handler: ((sessionId: string, data: string) => void) | null): void`. The handler fires for every `data` event, alongside the existing `webContents.send('terminal-data', ...)`.

- [ ] **Step 1: Add the field + setter**

In `daemon-client.ts`, next to the existing handler fields (~line 38-39), add:

```ts
  private terminalDataTap: ((sessionId: string, data: string) => void) | null = null
```

And next to `setTerminalExitHandler` (~line 50), add:

```ts
  setTerminalDataTap(handler: ((sessionId: string, data: string) => void) | null): void {
    this.terminalDataTap = handler
  }
```

- [ ] **Step 2: Fire the tap on data**

In the stream parser `if (msg.event === 'data')` block (~line 69-76), add a line after `this.window.webContents.send('terminal-data', msg.sessionId, msg.data)`:

```ts
          this.terminalDataTap?.(msg.sessionId, msg.data)
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/desktop && npx tsgo --noEmit -p tsconfig.node.json`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/daemon-client.ts
git commit -m "feat(desktop): add terminal-data tap to DaemonClient"
```

---

### Task 7: Sanitization helper (pure, TDD)

**Files:**
- Create: `apps/desktop/src/main/remote-bridge-sanitize.ts`
- Test: `apps/desktop/src/main/remote-bridge-sanitize.test.ts`

**Interfaces:**
- Consumes: `Workspace`, `TerminalSession` from `../shared/types`.
- Produces:
  - `sanitizeWorkspaces(workspaces: Record<string, Workspace>): SafeWorkspace[]`
  - `buildSessionMap(sessions: Record<string, TerminalSession>): Record<string, SafeSession>`
  - types `SafeWorkspace`, `SafeSession` (exported).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/remote-bridge-sanitize.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { sanitizeWorkspaces, buildSessionMap } from './remote-bridge-sanitize'
import type { Workspace, TerminalSession } from '../shared/types'

const ws: Record<string, Workspace> = {
  w1: {
    id: 'w1', name: 'App', color: '#fff', emoji: '🚀',
    trees: [{ rootDir: '/repo', sessionIds: ['s1'], displayName: 'main' }],
    activeTreeIndex: 0, customActions: [], createdAt: 1,
    linearConfig: { apiKey: 'SECRET', teamId: 't', teamName: 'T' },
  } as Workspace,
}

describe('sanitizeWorkspaces', () => {
  it('keeps display fields and trees', () => {
    const [out] = sanitizeWorkspaces(ws)
    expect(out.id).toBe('w1')
    expect(out.name).toBe('App')
    expect(out.emoji).toBe('🚀')
    expect(out.trees[0]).toEqual({ rootDir: '/repo', sessionIds: ['s1'], displayName: 'main' })
    expect(out.activeTreeIndex).toBe(0)
  })
  it('drops linearConfig and any secret fields', () => {
    const [out] = sanitizeWorkspaces(ws)
    expect((out as any).linearConfig).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain('SECRET')
  })
})

describe('buildSessionMap', () => {
  it('keeps only safe session fields', () => {
    const sessions: Record<string, TerminalSession> = {
      s1: { id: 's1', workspaceId: 'w1', label: 'claude', processStatus: 'claude', cwd: '/repo', shellPath: '/bin/zsh', actionIcon: 'Bot' } as TerminalSession,
    }
    const map = buildSessionMap(sessions)
    expect(map.s1).toEqual({ label: 'claude', processStatus: 'claude', cwd: '/repo', workspaceId: 'w1', actionIcon: 'Bot' })
    expect((map.s1 as any).shellPath).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/remote-bridge-sanitize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/main/remote-bridge-sanitize.ts`:

```ts
import type { Workspace, TerminalSession } from '../shared/types'

export interface SafeTree {
  rootDir: string
  sessionIds: string[]
  displayName?: string
}

export interface SafeWorkspace {
  id: string
  name: string
  color: string
  emoji?: string
  trees: SafeTree[]
  activeTreeIndex: number
}

export interface SafeSession {
  label: string
  processStatus: TerminalSession['processStatus']
  cwd: string
  workspaceId: string
  actionIcon?: string
}

/** Allow-list workspace fields the web needs; never emit secrets (linearConfig, etc). */
export function sanitizeWorkspaces(workspaces: Record<string, Workspace>): SafeWorkspace[] {
  return Object.values(workspaces).map((w) => ({
    id: w.id,
    name: w.name,
    color: w.color,
    emoji: w.emoji,
    trees: w.trees.map((t) => ({
      rootDir: t.rootDir,
      sessionIds: t.sessionIds,
      displayName: t.displayName,
    })),
    activeTreeIndex: w.activeTreeIndex,
  }))
}

export function buildSessionMap(
  sessions: Record<string, TerminalSession>,
): Record<string, SafeSession> {
  const out: Record<string, SafeSession> = {}
  for (const [id, s] of Object.entries(sessions)) {
    out[id] = {
      label: s.label,
      processStatus: s.processStatus,
      cwd: s.cwd,
      workspaceId: s.workspaceId,
      actionIcon: s.actionIcon,
    }
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/remote-bridge-sanitize.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/remote-bridge-sanitize.ts apps/desktop/src/main/remote-bridge-sanitize.test.ts
git commit -m "feat(desktop): pure workspace/session sanitizer for remote mirror"
```

---

### Task 8: Output batcher (pure, TDD)

**Files:**
- Create: `apps/desktop/src/main/remote-bridge-batcher.ts`
- Test: `apps/desktop/src/main/remote-bridge-batcher.test.ts`

**Interfaces:**
- Produces: `createOutputBatcher(opts: { flushMs: number; maxBytes: number; onFlush: (data: string) => void }): { push(data: string): void; flush(): void; dispose(): void }`. Buffers pushes; flushes on a timer (`flushMs` after the first buffered byte) or immediately when buffered length ≥ `maxBytes`. `flush()` forces a flush; `dispose()` cancels the timer.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/remote-bridge-batcher.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createOutputBatcher } from './remote-bridge-batcher'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createOutputBatcher', () => {
  it('coalesces pushes and flushes after flushMs', () => {
    const flushes: string[] = []
    const b = createOutputBatcher({ flushMs: 50, maxBytes: 1000, onFlush: (d) => flushes.push(d) })
    b.push('a'); b.push('b'); b.push('c')
    expect(flushes).toEqual([])
    vi.advanceTimersByTime(50)
    expect(flushes).toEqual(['abc'])
  })
  it('flushes immediately when maxBytes exceeded', () => {
    const flushes: string[] = []
    const b = createOutputBatcher({ flushMs: 50, maxBytes: 3, onFlush: (d) => flushes.push(d) })
    b.push('ab'); b.push('cd')
    expect(flushes).toEqual(['abcd'])
  })
  it('does not flush empty buffers', () => {
    const flushes: string[] = []
    const b = createOutputBatcher({ flushMs: 50, maxBytes: 1000, onFlush: (d) => flushes.push(d) })
    b.flush()
    vi.advanceTimersByTime(100)
    expect(flushes).toEqual([])
  })
  it('dispose cancels a pending flush', () => {
    const flushes: string[] = []
    const b = createOutputBatcher({ flushMs: 50, maxBytes: 1000, onFlush: (d) => flushes.push(d) })
    b.push('x'); b.dispose()
    vi.advanceTimersByTime(100)
    expect(flushes).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/remote-bridge-batcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/main/remote-bridge-batcher.ts`:

```ts
export interface OutputBatcher {
  push(data: string): void
  flush(): void
  dispose(): void
}

export function createOutputBatcher(opts: {
  flushMs: number
  maxBytes: number
  onFlush: (data: string) => void
}): OutputBatcher {
  let buffer = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const flush = () => {
    clearTimer()
    if (buffer.length === 0) return
    const out = buffer
    buffer = ''
    opts.onFlush(out)
  }

  return {
    push(data: string) {
      buffer += data
      if (buffer.length >= opts.maxBytes) {
        flush()
        return
      }
      if (!timer) timer = setTimeout(flush, opts.flushMs)
    },
    flush,
    dispose() {
      clearTimer()
      buffer = ''
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/remote-bridge-batcher.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/remote-bridge-batcher.ts apps/desktop/src/main/remote-bridge-batcher.test.ts
git commit -m "feat(desktop): pure output batcher for remote pty streaming"
```

---

### Task 9: Remote bridge module

**Files:**
- Create: `apps/desktop/src/main/remote-bridge.ts`
- Modify: `apps/desktop/src/main/convex-config.ts`
- Modify: `apps/desktop/src/main/env.d.ts`

**Interfaces:**
- Consumes: `sanitizeWorkspaces`, `buildSessionMap` (Task 7); `createOutputBatcher` (Task 8); `getDaemonClient()` and `DaemonClient.setTerminalDataTap` (Task 6); Convex functions (Tasks 3-4) via `anyApi`; `ConvexClient` from `convex/browser`; `CONVEX_CLOUD_URL`, `DEVICE_SECRET` from `convex-config`.
- Produces:
  - `startRemoteBridge(): void` — connect, begin command loop + status mirroring.
  - `remoteBridgeOnStatePersisted(data: PersistedData): void` — push sanitized state.
  - `stopRemoteBridge(): void`.

- [ ] **Step 1: Export DEVICE_SECRET from convex-config**

Modify `apps/desktop/src/main/convex-config.ts` — append:

```ts
export const DEVICE_SECRET = import.meta.env.MAIN_VITE_DEVICE_SECRET as string
```

- [ ] **Step 2: Declare the env var**

In `apps/desktop/src/main/env.d.ts`, add `MAIN_VITE_DEVICE_SECRET: string` to the `ImportMetaEnv` interface (follow the existing entries' style, e.g. alongside `MAIN_VITE_CONVEX_CLOUD_URL`).

- [ ] **Step 3: Write the bridge**

Create `apps/desktop/src/main/remote-bridge.ts`:

```ts
// Always-on bridge: mirrors sanitized workspace/session state to Convex and
// relays PTY I/O for the single session the web has attached. Inert if the
// DEVICE_SECRET env var is unset.

import { ConvexClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { CONVEX_CLOUD_URL, DEVICE_SECRET } from './convex-config'
import { getDaemonClient } from './daemon-client'
import { loadPersistedData } from './persistence'
import { sanitizeWorkspaces, buildSessionMap } from './remote-bridge-sanitize'
import { createOutputBatcher, type OutputBatcher } from './remote-bridge-batcher'
import type { PersistedData } from '../shared/types'

const FLUSH_MS = 50
const MAX_BYTES = 16 * 1024

let client: ConvexClient | null = null
let unsubscribeCommands: (() => void) | null = null

// Live status overlaid on the mirrored state.
const liveStatus: Record<string, { work: 'idle' | 'working'; exited?: boolean; label?: string }> = {}

// Attached-session streaming state.
let attachedSessionId: string | null = null
let seq = 0
let batcher: OutputBatcher | null = null

// Commands already applied (avoid re-processing across subscription refires).
const handledCommands = new Set<string>()

function isEnabled(): boolean {
  return !!DEVICE_SECRET && !!CONVEX_CLOUD_URL
}

function getClient(): ConvexClient {
  if (!client) client = new ConvexClient(CONVEX_CLOUD_URL)
  return client
}

export function startRemoteBridge(): void {
  if (!isEnabled()) {
    console.log('[remote-bridge] disabled (no DEVICE_SECRET) — running local-only')
    return
  }
  const c = getClient()

  // Output tap → batched chunk append (attached session only).
  getDaemonClient().setTerminalDataTap((sessionId, data) => {
    if (sessionId !== attachedSessionId || !batcher) return
    batcher.push(data)
  })

  // Status taps → liveStatus + push.
  getDaemonClient().setClaudeWorkStateHandler((sessionId, state) => {
    liveStatus[sessionId] = {
      ...liveStatus[sessionId],
      work: state === 'idle' ? 'idle' : 'working',
    }
    pushState()
  })
  getDaemonClient().setTerminalExitHandler((sessionId) => {
    liveStatus[sessionId] = { ...liveStatus[sessionId], work: 'idle', exited: true }
    if (sessionId === attachedSessionId) detach()
    pushState()
  })

  // Command loop.
  unsubscribeCommands = c.onUpdate(
    anyApi.remote.pendingCommands,
    { secret: DEVICE_SECRET },
    (commands: any[]) => { void applyCommands(commands) },
  )

  // Initial state push.
  pushState()
  console.log('[remote-bridge] started')
}

export function stopRemoteBridge(): void {
  unsubscribeCommands?.()
  unsubscribeCommands = null
  batcher?.dispose()
  batcher = null
  attachedSessionId = null
}

export function remoteBridgeOnStatePersisted(_data: PersistedData): void {
  if (!isEnabled()) return
  pushState()
}

function pushState(): void {
  if (!isEnabled()) return
  const data = loadPersistedData()
  void getClient().mutation(anyApi.remote.pushRemoteState, {
    secret: DEVICE_SECRET,
    workspaces: sanitizeWorkspaces(data.workspaces),
    sessions: buildSessionMap(data.sessions),
    liveStatus,
    activeWorkspaceId: data.activeWorkspaceId ?? null,
    activeSessionId: data.activeSessionId ?? null,
  })
}

async function applyCommands(commands: any[]): Promise<void> {
  const c = getClient()
  for (const cmd of commands) {
    const id = cmd._id as string
    if (handledCommands.has(id)) continue
    handledCommands.add(id)
    try {
      await applyOne(cmd)
    } catch (err) {
      console.error('[remote-bridge] command failed', cmd.kind, err)
    } finally {
      void c.mutation(anyApi.remote.deleteCommand, { secret: DEVICE_SECRET, id: cmd._id })
      handledCommands.delete(id)
    }
  }
}

async function applyOne(cmd: any): Promise<void> {
  const daemon = getDaemonClient()
  switch (cmd.kind) {
    case 'attach':
      await attach(cmd.sessionId)
      break
    case 'detach':
      detach()
      break
    case 'write':
      daemon.write(cmd.sessionId, String(cmd.payload?.data ?? ''))
      break
    case 'resize':
      await daemon.resize(cmd.sessionId, Number(cmd.payload?.cols), Number(cmd.payload?.rows))
      break
    case 'kill':
      await daemon.kill(cmd.sessionId)
      break
  }
}

async function attach(sessionId: string): Promise<void> {
  detach()
  attachedSessionId = sessionId
  seq = 0
  const c = getClient()
  // Reset the chunk log for a clean re-seed.
  await c.mutation(anyApi.remote.clearChunks, { secret: DEVICE_SECRET, sessionId })
  // Seed with the current screen so the web renders identically immediately.
  const snapshot = await getDaemonClient().getSnapshot(sessionId)
  const seed = snapshot ? snapshot.snapshotAnsi + snapshot.rehydrateSequences : ''
  if (seed) {
    await c.mutation(anyApi.remote.appendChunk, { secret: DEVICE_SECRET, sessionId, seq: seq++, data: seed })
  }
  batcher = createOutputBatcher({
    flushMs: FLUSH_MS,
    maxBytes: MAX_BYTES,
    onFlush: (data) => {
      if (attachedSessionId !== sessionId) return
      void c.mutation(anyApi.remote.appendChunk, { secret: DEVICE_SECRET, sessionId, seq: seq++, data })
    },
  })
}

function detach(): void {
  batcher?.flush()
  batcher?.dispose()
  batcher = null
  attachedSessionId = null
}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/desktop && npx tsgo --noEmit -p tsconfig.node.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/remote-bridge.ts apps/desktop/src/main/convex-config.ts apps/desktop/src/main/env.d.ts
git commit -m "feat(desktop): remote bridge (state mirror + pty relay)"
```

---

### Task 10: Wire bridge into startup + persist + env

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/.env` and `apps/desktop/.env.development` (env vars)

**Interfaces:**
- Consumes: `startRemoteBridge`, `remoteBridgeOnStatePersisted` (Task 9).

- [ ] **Step 1: Import the bridge**

In `apps/desktop/src/main/index.ts`, add to the imports near the `webhook-listener` import block (around line 36):

```ts
import { startRemoteBridge, remoteBridgeOnStatePersisted } from './remote-bridge'
```

- [ ] **Step 2: Start the bridge at startup**

In `index.ts`, immediately after the `startWebhookListener(mainWindow)` call (~line 384), add:

```ts
  startRemoteBridge()
```

- [ ] **Step 3: Push state on persist**

In the `ipcMain.on('save-state', ...)` handler (~line 690), add after the `saveWorkspaces(...)` call (and before/around the `syncRepositoryWorkspaceSettings` try block):

```ts
  remoteBridgeOnStatePersisted(loadPersistedData())
```

(`loadPersistedData` is already imported in this file.)

- [ ] **Step 4: Add env vars**

Add to `apps/desktop/.env` and `apps/desktop/.env.development` (use the `DEVICE_SECRET` value from Task 5 Step 4):

```
MAIN_VITE_DEVICE_SECRET=<the-device-secret-from-convex>
```

- [ ] **Step 5: Typecheck + build smoke**

Run: `cd apps/desktop && npx tsgo --noEmit -p tsconfig.node.json && npx tsgo --noEmit -p tsconfig.web.json`
Expected: PASS.

- [ ] **Step 6: Manual verification**

Run the desktop app (`bun run --filter @orchestra/desktop dev` or the `desktop:dev` skill). In the Convex dashboard, open the `remoteState` table — confirm a single row appears with your workspaces (and **no** `linearConfig`/API keys anywhere). Create/rename a session and confirm the row updates.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat(desktop): start remote bridge + mirror state on persist"
```

---

## Phase C — Web app

### Task 11: Web Convex client + env + deps

**Files:**
- Modify: `apps/web/package.json` (deps)
- Create: `apps/web/.env.local`
- Create: `apps/web/src/lib/convexClient.ts`

**Interfaces:**
- Produces: `getConvexClient(): ConvexReactClient`; `CONVEX_URL` constant.

- [ ] **Step 1: Install deps**

Run: `cd apps/web && bun add convex @xterm/xterm @xterm/addon-fit`
Expected: deps added to `package.json`.

- [ ] **Step 2: Add env**

Create `apps/web/.env.local` (use your deployment's URL from `apps/backend/.env.local`'s `CONVEX_URL`, the `.convex.cloud` one):

```
NEXT_PUBLIC_CONVEX_URL=https://<your-deployment>.convex.cloud
```

- [ ] **Step 3: Create the client module**

Create `apps/web/src/lib/convexClient.ts`:

```ts
import { ConvexReactClient } from 'convex/react'

export const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL as string

let client: ConvexReactClient | null = null

export function getConvexClient(): ConvexReactClient {
  if (!client) client = new ConvexReactClient(CONVEX_URL)
  return client
}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/bun.lock apps/web/.env.local apps/web/src/lib/convexClient.ts
git commit -m "feat(web): convex client + deps"
```

> If `.env.local` is gitignored (default in Next.js), skip adding it to git and note the required var in `apps/web/README.md` instead.

---

### Task 12: Chunk buffer (pure, TDD)

**Files:**
- Create: `apps/web/src/lib/chunk-buffer.ts`
- Test: `apps/web/src/lib/chunk-buffer.test.ts`

**Interfaces:**
- Produces:
  - type `Chunk = { seq: number; data: string }`
  - `nextChunks(chunks: Chunk[], afterSeq: number): { data: string; afterSeq: number }` — returns the concatenated data of all chunks with `seq > afterSeq` in seq order (deduped), and the new high-water `afterSeq`. If none, returns `{ data: '', afterSeq }` unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/chunk-buffer.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { nextChunks } from './chunk-buffer'

describe('nextChunks', () => {
  it('concatenates new chunks in seq order', () => {
    const r = nextChunks([{ seq: 1, data: 'a' }, { seq: 2, data: 'b' }], 0)
    expect(r).toEqual({ data: 'ab', afterSeq: 2 })
  })
  it('skips already-seen seqs', () => {
    const r = nextChunks([{ seq: 1, data: 'a' }, { seq: 2, data: 'b' }, { seq: 3, data: 'c' }], 2)
    expect(r).toEqual({ data: 'c', afterSeq: 3 })
  })
  it('orders out-of-order input', () => {
    const r = nextChunks([{ seq: 3, data: 'c' }, { seq: 1, data: 'a' }, { seq: 2, data: 'b' }], 0)
    expect(r).toEqual({ data: 'abc', afterSeq: 3 })
  })
  it('returns empty + unchanged afterSeq when nothing new', () => {
    const r = nextChunks([{ seq: 1, data: 'a' }], 1)
    expect(r).toEqual({ data: '', afterSeq: 1 })
  })
  it('dedupes repeated seqs', () => {
    const r = nextChunks([{ seq: 1, data: 'a' }, { seq: 1, data: 'a' }], 0)
    expect(r).toEqual({ data: 'a', afterSeq: 1 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test src/lib/chunk-buffer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/chunk-buffer.ts`:

```ts
export type Chunk = { seq: number; data: string }

export function nextChunks(
  chunks: Chunk[],
  afterSeq: number,
): { data: string; afterSeq: number } {
  const fresh = chunks
    .filter((c) => c.seq > afterSeq)
    .sort((a, b) => a.seq - b.seq)
  let data = ''
  let seen = afterSeq
  for (const c of fresh) {
    if (c.seq <= seen) continue // dedupe
    data += c.data
    seen = c.seq
  }
  return { data, afterSeq: seen }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun test src/lib/chunk-buffer.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/chunk-buffer.ts apps/web/src/lib/chunk-buffer.test.ts
git commit -m "feat(web): pure chunk-ordering buffer"
```

---

### Task 13: Auth hook + sign-in + providers

**Files:**
- Create: `apps/web/src/lib/useAuth.ts`
- Create: `apps/web/src/components/SignIn.tsx`
- Modify: `apps/web/src/app/layout.tsx`

**Interfaces:**
- Consumes: `getConvexClient` (Task 11); `anyApi.remoteAuth.signIn`.
- Produces:
  - `useAuth(): { token: string | null; signIn(email,password): Promise<string|null>; signOut(): void }`
  - `<SignIn onSignedIn={(token)=>void} />`
  - `layout.tsx` wraps children in `ConvexProvider`.

- [ ] **Step 1: Auth hook**

Create `apps/web/src/lib/useAuth.ts`:

```ts
'use client'
import { useCallback, useEffect, useState } from 'react'
import { useConvex } from 'convex/react'
import { anyApi } from 'convex/server'

const KEY = 'orchestra-web-token'

export function useAuth() {
  const convex = useConvex()
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    setToken(localStorage.getItem(KEY))
  }, [])

  const signIn = useCallback(
    async (email: string, password: string): Promise<string | null> => {
      const res = await convex.action(anyApi.remoteAuth.signIn, { email, password })
      if (res && 'token' in res) {
        localStorage.setItem(KEY, res.token)
        setToken(res.token)
        return res.token
      }
      return null
    },
    [convex],
  )

  const signOut = useCallback(() => {
    localStorage.removeItem(KEY)
    setToken(null)
  }, [])

  return { token, signIn, signOut }
}
```

- [ ] **Step 2: Sign-in component**

Create `apps/web/src/components/SignIn.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { useAuth } from '../lib/useAuth'

export function SignIn({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const token = await signIn(email, password)
    setBusy(false)
    if (token) onSignedIn(token)
    else setError('Invalid credentials')
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 320, margin: '15vh auto', display: 'grid', gap: 12 }}>
      <h1 style={{ fontSize: 20 }}>Orchestra Web</h1>
      <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
        autoComplete="username" required style={{ padding: 10 }} />
      <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password" required style={{ padding: 10 }} />
      <button type="submit" disabled={busy} style={{ padding: 10 }}>{busy ? '…' : 'Sign in'}</button>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
    </form>
  )
}
```

- [ ] **Step 3: Provider in layout**

Replace `apps/web/src/app/layout.tsx` body with a client provider wrapper. Create `apps/web/src/components/Providers.tsx`:

```tsx
'use client'
import { ConvexProvider } from 'convex/react'
import { getConvexClient } from '../lib/convexClient'

export function Providers({ children }: { children: React.ReactNode }) {
  return <ConvexProvider client={getConvexClient()}>{children}</ConvexProvider>
}
```

Then in `apps/web/src/app/layout.tsx`, wrap `{children}` with `<Providers>`:

```tsx
import { Providers } from '../components/Providers'
// inside <body>:
//   <Providers>{children}</Providers>
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/useAuth.ts apps/web/src/components/SignIn.tsx apps/web/src/components/Providers.tsx apps/web/src/app/layout.tsx
git commit -m "feat(web): auth hook, sign-in form, convex provider"
```

---

### Task 14: Sidebar

**Files:**
- Create: `apps/web/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `anyApi.remote.getRemoteState` with `{ token }`; `SafeWorkspace`/`SafeSession` shapes (Task 7 — mirror inline as a local type).
- Produces: `<Sidebar token onSelect={(sessionId)=>void} selectedId />`.

- [ ] **Step 1: Implement the sidebar**

Create `apps/web/src/components/Sidebar.tsx`:

```tsx
'use client'
import { useQuery } from 'convex/react'
import { anyApi } from 'convex/server'

export function Sidebar({
  token,
  selectedId,
  onSelect,
}: {
  token: string
  selectedId: string | null
  onSelect: (sessionId: string) => void
}) {
  const state = useQuery(anyApi.remote.getRemoteState, { token })

  if (state === undefined) return <div style={{ padding: 12 }}>Loading…</div>
  if (state === null) return <div style={{ padding: 12 }}>Desktop not connected</div>

  const workspaces = (state.workspaces ?? []) as any[]
  const sessions = (state.sessions ?? {}) as Record<string, any>
  const liveStatus = (state.liveStatus ?? {}) as Record<string, any>

  return (
    <div style={{ overflowY: 'auto', height: '100%' }}>
      {workspaces.map((ws) => (
        <div key={ws.id} style={{ marginBottom: 8 }}>
          <div style={{ padding: '6px 10px', fontWeight: 600 }}>
            {ws.emoji ? ws.emoji + ' ' : ''}{ws.name}
          </div>
          {ws.trees.map((tree: any, ti: number) => (
            <div key={ti} style={{ paddingLeft: 12 }}>
              {tree.displayName && (
                <div style={{ fontSize: 11, opacity: 0.6, padding: '2px 10px' }}>{tree.displayName}</div>
              )}
              {tree.sessionIds.map((sid: string) => {
                const s = sessions[sid]
                if (!s) return null
                const status = liveStatus[sid]
                const dot = status?.exited ? '⚪️' : status?.work === 'working' ? '🟢' : '⚪️'
                return (
                  <button
                    key={sid}
                    onClick={() => onSelect(sid)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
                      background: sid === selectedId ? '#2b2b2b' : 'transparent', color: 'inherit',
                      border: 'none', cursor: 'pointer',
                    }}
                  >
                    {dot} {status?.label ?? s.label}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx
git commit -m "feat(web): workspace/session sidebar from remoteState"
```

---

### Task 15: Terminal pane + controls

**Files:**
- Create: `apps/web/src/components/Terminal.tsx`

**Interfaces:**
- Consumes: `nextChunks` (Task 12); `anyApi.remote.getChunks`, `anyApi.remote.sendCommand`; `@xterm/xterm`, `@xterm/addon-fit`.
- Produces: `<TerminalPane token sessionId />`.

- [ ] **Step 1: Implement the terminal**

Create `apps/web/src/components/Terminal.tsx`:

```tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { nextChunks, type Chunk } from '../lib/chunk-buffer'
import '@xterm/xterm/css/xterm.css'

const CONTROLS: { label: string; bytes: string }[] = [
  { label: '⏎', bytes: '\r' },
  { label: 'Esc', bytes: '\x1b' },
  { label: 'Ctrl-C', bytes: '\x03' },
  { label: '↑', bytes: '\x1b[A' },
  { label: '↓', bytes: '\x1b[B' },
]

export function TerminalPane({ token, sessionId }: { token: string; sessionId: string }) {
  const convex = useConvex()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [afterSeq, setAfterSeq] = useState(-1)

  const send = (kind: string, payload: unknown) =>
    void convex.mutation(anyApi.remote.sendCommand, { token, sessionId, kind, payload })

  // Mount xterm + attach lifecycle.
  useEffect(() => {
    const term = new Terminal({ convertEol: false, fontSize: 13, cursorBlink: true })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    setAfterSeq(-1)

    send('attach', {})
    void convex.mutation(anyApi.remote.sendCommand, {
      token, sessionId, kind: 'resize', payload: { cols: term.cols, rows: term.rows },
    })

    const onData = term.onData((data) => send('write', { data }))
    const onResize = () => {
      fit.fit()
      send('resize', { cols: term.cols, rows: term.rows })
    }
    window.addEventListener('resize', onResize)

    return () => {
      send('detach', {})
      onData.dispose()
      window.removeEventListener('resize', onResize)
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Stream chunks → xterm.
  const chunks = useQuery(anyApi.remote.getChunks, { token, sessionId, afterSeq }) as Chunk[] | undefined
  useEffect(() => {
    if (!chunks || chunks.length === 0 || !termRef.current) return
    const { data, afterSeq: next } = nextChunks(chunks, afterSeq)
    if (data) termRef.current.write(data)
    if (next !== afterSeq) setAfterSeq(next)
  }, [chunks, afterSeq])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
      <div style={{ display: 'flex', gap: 6, padding: 6, borderTop: '1px solid #333' }}>
        {CONTROLS.map((c) => (
          <button key={c.label} onClick={() => send('write', { data: c.bytes })}
            style={{ padding: '8px 12px' }}>{c.label}</button>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/Terminal.tsx
git commit -m "feat(web): xterm terminal pane with attach/stream/input/controls"
```

---

### Task 16: Compose page + end-to-end verification

**Files:**
- Modify: `apps/web/src/app/page.tsx`

**Interfaces:**
- Consumes: `useAuth` (Task 13), `SignIn`, `Sidebar`, `TerminalPane`.

- [ ] **Step 1: Compose the app**

Replace `apps/web/src/app/page.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { useAuth } from '../lib/useAuth'
import { SignIn } from '../components/SignIn'
import { Sidebar } from '../components/Sidebar'
import { TerminalPane } from '../components/Terminal'

export default function Page() {
  const { token } = useAuth()
  const [selected, setSelected] = useState<string | null>(null)

  // Page and SignIn hold separate useAuth instances, so Page won't re-render
  // when SignIn updates its own token state. Reload to pick up the stored token.
  if (!token) return <SignIn onSignedIn={() => location.reload()} />

  return (
    <div style={{ display: 'flex', height: '100dvh', color: '#eee', background: '#1a1a1a' }}>
      <div style={{ width: 240, borderRight: '1px solid #333', flexShrink: 0 }}>
        <Sidebar token={token} selectedId={selected} onSelect={setSelected} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {selected ? (
          <TerminalPane token={token} sessionId={selected} />
        ) : (
          <div style={{ padding: 16, opacity: 0.6 }}>Select a session</div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd apps/web && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 3: End-to-end manual verification**

1. Ensure the desktop app is running (bridge started) and at least one Claude/terminal session exists.
2. Run the web app: `cd apps/web && bun run dev`. Open `http://localhost:3000` (and from your phone via your machine's LAN IP, or deploy to Vercel and open on the go).
3. Sign in with `REMOTE_EMAIL` / `REMOTE_PASSWORD`. A wrong password is rejected.
4. Confirm the sidebar mirrors the desktop's workspaces → sessions, with live status dots; create/rename a session on desktop and watch it update.
5. Select a running session → the terminal renders the current screen immediately (snapshot), then streams live output.
6. Type a command/prompt → it reaches the agent on desktop. Press Esc / Ctrl-C / arrows → they work.
7. In the Convex dashboard, confirm `ptyChunks` only accumulate for the attached session and get pruned; confirm **no secret** (Linear API key) appears in `remoteState`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/page.tsx
git commit -m "feat(web): compose auth + sidebar + terminal into the app"
```

---

## Self-Review Notes (addressed)

- **Spec coverage:** transport (Convex relay — all tasks), auth env+token no-signup (Tasks 2, 13), always-on bridge + continuous state mirror (Tasks 9-10), attached-session streaming with snapshot seed (Task 9 `attach`), sanitization/no secrets (Task 7, verified Tasks 10/16), xterm web UI (Tasks 14-16), cost controls/prune (Tasks 5, 8), testing (Tasks 2,7,8,12 unit; 10,16 manual e2e). Out-of-scope `/remote-control` removal intentionally excluded.
- **Refinements from spec:** chunks stored as strings (not base64) since data is already decoded at the tap; agent controls are raw byte writes (no `shared/agent-controls` import) — both recorded in Global Constraints.
- **Type consistency:** command kinds (`write`/`resize`/`kill`/`attach`/`detach`) identical across schema (Task 1), `sendCommand` (Task 4), bridge `applyOne` (Task 9), and web `send` (Task 15). `secret` guards bridge functions; `token` guards web functions throughout. `nextChunks` signature identical in Tasks 12 and 15.
