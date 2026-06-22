# Web Worktree Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Orchestra web remote control create a git worktree on any workspace via a dialog that is a 1:1 port of the desktop `WorktreeDialog`, running the exact same creation flow on the desktop and auto-attaching to the spun-up session.

**Architecture:** Reuse the existing web-remote command pattern (sanitize → Convex `sendCommand` kind → bridge IPC → renderer hook) established by the Web Remote Actions Bar. A new `createWorktree` command kind carries `{ workspaceId, branch, selectedActionIds, spinUp }`. The desktop's inline `handleCreateWorktree` body is extracted into a shared, dependency-injected `runWorktreeCreation` function that both the desktop dialog and a new `useRemoteWorktree` hook call. The web sends the command from a per-workspace "+ New worktree" dialog and arms the existing pending-attach window.

**Tech Stack:** Convex (backend), Electron main + preload (Node/TS), React 19 renderer (Zustand store, vitest), Next.js web (React 19, bun:test for pure lib).

## Global Constraints

- **Fire-and-forget remote channel:** the web sends the command and observes mirrored state; no result/error is sent back to the web. Desktop still surfaces failures via `window.alert` on its local dialog path only. (Per spec — no new backend surface for results.)
- **Spin-up agent list (verbatim, both desktop & web):** `'terminal' | 'claude' | 'codex' | 'cursor'`. Initial commands: claude→`claude`, codex→`codex`, cursor→`agent --force --model composer-2-fast`, terminal→`undefined`.
- **`sessionId` is unused for `createWorktree`** — pass `""`, same convention as `runAction`.
- **Web has no DOM/component test harness** (only pure `src/lib/*.test.ts` via bun:test). Web components (`WorktreeDialog`, sidebar wiring) are verified by typecheck + lint, mirroring the untested `ActionBar`. Web *logic* is unit-tested as a pure lib helper.
- **Commit trailer (every commit):**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01GWwZXGRBboyM3AbXqYe68C
  ```

## File Structure

- **Backend**
  - Modify `apps/backend/convex/schema.ts` — add `"createWorktree"` to `ptyCommands.kind` union + comment.
  - Modify `apps/backend/convex/remote.ts` — add `"createWorktree"` to `sendCommand` `kind` union.
- **Desktop main**
  - Create `apps/desktop/src/main/remote-bridge-create-worktree.ts` — pure `normalizeCreateWorktreePayload` + `SpinUpAgent`/`CreateWorktreePayload` types.
  - Create `apps/desktop/src/main/remote-bridge-create-worktree.test.ts` — vitest.
  - Modify `apps/desktop/src/main/remote-bridge.ts` — `applyOne` gains `case 'createWorktree'`.
- **Desktop preload + shared types**
  - Modify `apps/desktop/src/preload/index.ts` — add `onRemoteCreateWorktree` + `removeAllListeners('remote-create-worktree')`.
  - Modify `apps/desktop/src/shared/types.ts` — add `onRemoteCreateWorktree` to `ElectronAPI`.
- **Desktop renderer**
  - Create `apps/desktop/src/renderer/src/utils/worktree-creation.ts` — `runWorktreeCreation` + `WorktreeCreationDeps`/`WorktreeCreationInput`.
  - Create `apps/desktop/src/renderer/src/utils/worktree-creation.test.ts` — vitest.
  - Modify `apps/desktop/src/renderer/src/components/Sidebar.tsx` — `handleCreateWorktree` calls `runWorktreeCreation`.
  - Create `apps/desktop/src/renderer/src/hooks/useRemoteWorktree.ts` — listens `remote-create-worktree`.
  - Modify `apps/desktop/src/renderer/src/App.tsx` — call `useRemoteWorktree()`.
- **Web**
  - Modify `apps/web/src/lib/actions.ts` — add `SpinUpAgent`, `SPIN_UP_AGENTS`, `buildCreateWorktreePayload`.
  - Modify `apps/web/src/lib/actions.test.ts` — tests for the new helpers.
  - Create `apps/web/src/components/WorktreeDialog.tsx` — port of the desktop dialog.
  - Modify `apps/web/src/components/Sidebar.tsx` — `customActions` on `SafeWorkspace`, "+ New worktree" row, dialog wiring.
  - Modify `apps/web/src/app/page.tsx` — thread the attach-arm callback to `AppSidebar`.

---

### Task 1: Backend — `createWorktree` command kind

**Files:**
- Modify: `apps/backend/convex/schema.ts:108-120`
- Modify: `apps/backend/convex/remote.ts:92-111`

**Interfaces:**
- Produces: a new `"createWorktree"` literal accepted by the `ptyCommands.kind` union and the `sendCommand` `kind` arg. Payload (validated as `v.any()`): `{ workspaceId: string; branch: string; selectedActionIds: string[]; spinUp: 'terminal'|'claude'|'codex'|'cursor'|null }`.

- [ ] **Step 1: Add the kind to the schema union**

In `apps/backend/convex/schema.ts`, change the `ptyCommands.kind` union and comment to:

```ts
  ptyCommands: defineTable({
    sessionId: v.string(),
    kind: v.union(
      v.literal("write"),
      v.literal("resize"),
      v.literal("kill"),
      v.literal("attach"),
      v.literal("detach"),
      v.literal("runAction"),
      v.literal("createWorktree"),
    ),
    payload: v.any(),          // write:{data}; resize:{cols,rows}; runAction:{workspaceId,actionId}; createWorktree:{workspaceId,branch,selectedActionIds,spinUp}; others:{}
    createdAt: v.number(),
  }).index("by_created", ["createdAt"]),
```

- [ ] **Step 2: Add the kind to the `sendCommand` mutation union**

In `apps/backend/convex/remote.ts`, in the `sendCommand` `args.kind` union, add the literal after `runAction`:

```ts
    kind: v.union(
      v.literal("write"),
      v.literal("resize"),
      v.literal("kill"),
      v.literal("attach"),
      v.literal("detach"),
      v.literal("runAction"),
      v.literal("createWorktree"),
    ),
```

- [ ] **Step 3: Typecheck the backend**

Run: `cd apps/backend && bun run typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/convex/schema.ts apps/backend/convex/remote.ts
git commit -m "feat(backend): add createWorktree remote command kind

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GWwZXGRBboyM3AbXqYe68C"
```

---

### Task 2: Desktop main — payload normalizer + bridge routing

**Files:**
- Create: `apps/desktop/src/main/remote-bridge-create-worktree.ts`
- Test: `apps/desktop/src/main/remote-bridge-create-worktree.test.ts`
- Modify: `apps/desktop/src/main/remote-bridge.ts:143-175` (`applyOne`)

**Interfaces:**
- Produces: `export type SpinUpAgent = 'terminal' | 'claude' | 'codex' | 'cursor'`; `export interface CreateWorktreePayload { workspaceId: string; branch: string; selectedActionIds: string[]; spinUp: SpinUpAgent | null }`; `export function normalizeCreateWorktreePayload(payload: unknown): CreateWorktreePayload`.
- Consumes (in bridge): `mainWindow?.webContents.send('remote-create-worktree', payload)`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/remote-bridge-create-worktree.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { normalizeCreateWorktreePayload } from './remote-bridge-create-worktree'

describe('normalizeCreateWorktreePayload', () => {
  it('coerces fields and preserves a valid spinUp', () => {
    expect(
      normalizeCreateWorktreePayload({
        workspaceId: 'w1',
        branch: 'feature/x',
        selectedActionIds: ['a1', 'a2'],
        spinUp: 'claude',
      }),
    ).toEqual({
      workspaceId: 'w1',
      branch: 'feature/x',
      selectedActionIds: ['a1', 'a2'],
      spinUp: 'claude',
    })
  })

  it('defaults missing fields and nulls an invalid spinUp', () => {
    expect(normalizeCreateWorktreePayload({ spinUp: 'bogus' })).toEqual({
      workspaceId: '',
      branch: '',
      selectedActionIds: [],
      spinUp: null,
    })
  })

  it('forces selectedActionIds to a string array when not an array', () => {
    expect(normalizeCreateWorktreePayload({ selectedActionIds: 'nope' }).selectedActionIds).toEqual([])
    expect(normalizeCreateWorktreePayload({ selectedActionIds: [1, 2] }).selectedActionIds).toEqual(['1', '2'])
  })

  it('handles a null/undefined payload', () => {
    expect(normalizeCreateWorktreePayload(undefined)).toEqual({
      workspaceId: '',
      branch: '',
      selectedActionIds: [],
      spinUp: null,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/remote-bridge-create-worktree.test.ts`
Expected: FAIL with "Failed to resolve import './remote-bridge-create-worktree'".

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/main/remote-bridge-create-worktree.ts`:

```ts
// Pure normalizer for the web→desktop `createWorktree` command payload. Kept in
// its own module (free of Electron imports) so it is unit-testable, mirroring
// the other remote-bridge helpers (sanitize/batcher/settle).

export type SpinUpAgent = 'terminal' | 'claude' | 'codex' | 'cursor'

const SPIN_UP_AGENTS: SpinUpAgent[] = ['terminal', 'claude', 'codex', 'cursor']

export interface CreateWorktreePayload {
  workspaceId: string
  branch: string
  selectedActionIds: string[]
  spinUp: SpinUpAgent | null
}

export function normalizeCreateWorktreePayload(payload: unknown): CreateWorktreePayload {
  const p = (payload ?? {}) as Record<string, unknown>
  const spinUpRaw = p.spinUp
  const spinUp = SPIN_UP_AGENTS.includes(spinUpRaw as SpinUpAgent) ? (spinUpRaw as SpinUpAgent) : null
  return {
    workspaceId: String(p.workspaceId ?? ''),
    branch: String(p.branch ?? ''),
    selectedActionIds: Array.isArray(p.selectedActionIds) ? p.selectedActionIds.map((x) => String(x)) : [],
    spinUp,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/remote-bridge-create-worktree.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Route the command in `applyOne`**

In `apps/desktop/src/main/remote-bridge.ts`, add the import near the top (with the other local imports):

```ts
import { normalizeCreateWorktreePayload } from './remote-bridge-create-worktree'
```

In `applyOne`, add a new case after the `runAction` case (before the closing `}` of the switch):

```ts
    case 'createWorktree':
      // Worktree creation lives in the renderer store; forward to it like runAction.
      mainWindow?.webContents.send('remote-create-worktree', normalizeCreateWorktreePayload(cmd.payload))
      break
```

- [ ] **Step 6: Typecheck the desktop main**

Run: `cd apps/desktop && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/remote-bridge-create-worktree.ts apps/desktop/src/main/remote-bridge-create-worktree.test.ts apps/desktop/src/main/remote-bridge.ts
git commit -m "feat(desktop): route createWorktree command to the renderer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GWwZXGRBboyM3AbXqYe68C"
```

---

### Task 3: Desktop preload + shared types — `onRemoteCreateWorktree`

**Files:**
- Modify: `apps/desktop/src/preload/index.ts:159-160` (removeAllListeners) and `:279-283` (listener method)
- Modify: `apps/desktop/src/shared/types.ts:452-453` (ElectronAPI)

**Interfaces:**
- Produces: `electronAPI.onRemoteCreateWorktree(cb: (data: { workspaceId: string; branch: string; selectedActionIds: string[]; spinUp: 'terminal'|'claude'|'codex'|'cursor'|null }) => void): () => void`. Channel: `remote-create-worktree`.
- Consumes: the `webContents.send('remote-create-worktree', ...)` from Task 2.

- [ ] **Step 1: Add the listener method in preload**

In `apps/desktop/src/preload/index.ts`, immediately after the `onRemoteRunAction` method (ends at line 283), add:

```ts
  onRemoteCreateWorktree: (
    callback: (data: {
      workspaceId: string
      branch: string
      selectedActionIds: string[]
      spinUp: 'terminal' | 'claude' | 'codex' | 'cursor' | null
    }) => void,
  ) => {
    const handler = (
      _event: any,
      data: {
        workspaceId: string
        branch: string
        selectedActionIds: string[]
        spinUp: 'terminal' | 'claude' | 'codex' | 'cursor' | null
      },
    ) => callback(data)
    ipcRenderer.on('remote-create-worktree', handler)
    return () => {
      ipcRenderer.removeListener('remote-create-worktree', handler)
    }
  },
```

- [ ] **Step 2: Add the cleanup line**

In `apps/desktop/src/preload/index.ts`, after line 159 (`ipcRenderer.removeAllListeners('remote-run-action')`), add:

```ts
    ipcRenderer.removeAllListeners('remote-create-worktree')
```

- [ ] **Step 3: Add the ElectronAPI type**

In `apps/desktop/src/shared/types.ts`, after the `onRemoteRunAction` line (452), add:

```ts
  onRemoteCreateWorktree: (callback: (data: { workspaceId: string; branch: string; selectedActionIds: string[]; spinUp: 'terminal' | 'claude' | 'codex' | 'cursor' | null }) => void) => () => void
```

- [ ] **Step 4: Typecheck the desktop**

Run: `cd apps/desktop && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/preload/index.ts apps/desktop/src/shared/types.ts
git commit -m "feat(desktop): preload onRemoteCreateWorktree bridge method

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GWwZXGRBboyM3AbXqYe68C"
```

---

### Task 4: Desktop renderer — extract `runWorktreeCreation` + refactor dialog handler

**Files:**
- Create: `apps/desktop/src/renderer/src/utils/worktree-creation.ts`
- Test: `apps/desktop/src/renderer/src/utils/worktree-creation.test.ts`
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx:1363-1391` (`handleCreateWorktree`)

**Interfaces:**
- Produces:
  ```ts
  export type SpinUpAgent = 'terminal' | 'claude' | 'codex' | 'cursor'
  export interface WorktreeCreationInput { branch: string; selectedActionIds: string[]; spinUp: SpinUpAgent | null }
  export interface WorktreeCreationDeps {
    workspace: { trees: { rootDir: string }[]; customActions: CustomAction[] }
    worktreesDir: string
    createWorktree: (repoDir: string, branch: string, worktreesDir: string) => Promise<{ success: boolean; path?: string; error?: string }>
    addWorktree: (workspaceId: string, rootDir: string) => void
    runAction: (workspaceId: string, action: CustomAction) => void
    runBackgroundAction: (action: CustomAction) => void
    createSession: (workspaceId: string, initialCommand: string | undefined, processStatus: 'terminal' | 'claude' | 'codex' | 'cursor', treeIndex: number) => void
  }
  export function runWorktreeCreation(deps: WorktreeCreationDeps, workspaceId: string, input: WorktreeCreationInput): Promise<{ success: boolean; error?: string }>
  ```
- Consumes: `CustomAction` from `apps/desktop/src/shared/types.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/utils/worktree-creation.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { runWorktreeCreation, type WorktreeCreationDeps } from './worktree-creation'
import type { CustomAction } from '../../../shared/types'

const fgAction = { id: 'a1', name: 'Deploy', icon: '__terminal__' } as unknown as CustomAction
const bgAction = { id: 'a2', name: 'Lint', icon: '__terminal__', runInBackground: true } as unknown as CustomAction

function makeDeps(overrides: Partial<WorktreeCreationDeps> = {}): WorktreeCreationDeps {
  return {
    workspace: { trees: [{ rootDir: '/repo' }], customActions: [fgAction, bgAction] },
    worktreesDir: '/wt',
    createWorktree: vi.fn().mockResolvedValue({ success: true, path: '/wt/repo/feature' }),
    addWorktree: vi.fn(),
    runAction: vi.fn(),
    runBackgroundAction: vi.fn(),
    createSession: vi.fn(),
    ...overrides,
  }
}

describe('runWorktreeCreation', () => {
  it('adds the worktree, runs selected actions (fg+bg), and spins up the agent on success', async () => {
    const deps = makeDeps()
    const res = await runWorktreeCreation(deps, 'w1', {
      branch: 'feature',
      selectedActionIds: ['a1', 'a2'],
      spinUp: 'claude',
    })
    expect(res).toEqual({ success: true })
    expect(deps.createWorktree).toHaveBeenCalledWith('/repo', 'feature', '/wt')
    expect(deps.addWorktree).toHaveBeenCalledWith('w1', '/wt/repo/feature')
    expect(deps.runAction).toHaveBeenCalledWith('w1', fgAction)
    expect(deps.runBackgroundAction).toHaveBeenCalledWith(bgAction)
    // tree index 1 = the new worktree (main repo is index 0)
    expect(deps.createSession).toHaveBeenCalledWith('w1', 'claude', 'claude', 1)
  })

  it('only runs the selected actions', async () => {
    const deps = makeDeps()
    await runWorktreeCreation(deps, 'w1', { branch: 'b', selectedActionIds: ['a1'], spinUp: null })
    expect(deps.runAction).toHaveBeenCalledWith('w1', fgAction)
    expect(deps.runBackgroundAction).not.toHaveBeenCalled()
    expect(deps.createSession).not.toHaveBeenCalled()
  })

  it('no-ops and returns the error when worktree creation fails', async () => {
    const deps = makeDeps({
      createWorktree: vi.fn().mockResolvedValue({ success: false, error: 'branch exists' }),
    })
    const res = await runWorktreeCreation(deps, 'w1', { branch: 'dup', selectedActionIds: ['a1'], spinUp: 'claude' })
    expect(res).toEqual({ success: false, error: 'branch exists' })
    expect(deps.addWorktree).not.toHaveBeenCalled()
    expect(deps.runAction).not.toHaveBeenCalled()
    expect(deps.createSession).not.toHaveBeenCalled()
  })

  it('maps cursor spinUp to its initial command', async () => {
    const deps = makeDeps()
    await runWorktreeCreation(deps, 'w1', { branch: 'b', selectedActionIds: [], spinUp: 'cursor' })
    expect(deps.createSession).toHaveBeenCalledWith('w1', 'agent --force --model composer-2-fast', 'cursor', 1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/renderer/src/utils/worktree-creation.test.ts`
Expected: FAIL with "Failed to resolve import './worktree-creation'".

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/renderer/src/utils/worktree-creation.ts`:

```ts
import type { CustomAction } from '../../../shared/types'

export type SpinUpAgent = 'terminal' | 'claude' | 'codex' | 'cursor'

export interface WorktreeCreationInput {
  branch: string
  selectedActionIds: string[]
  spinUp: SpinUpAgent | null
}

// Dependencies injected by the caller so this flow stays pure and testable.
// The desktop dialog wires its real store actions + local runBackgroundAction;
// the remote hook (useRemoteWorktree) wires store actions from getState() and a
// runBackgroundAction that falls back to an interactive run (the headless
// background machinery is Sidebar-local).
export interface WorktreeCreationDeps {
  workspace: { trees: { rootDir: string }[]; customActions: CustomAction[] }
  worktreesDir: string
  createWorktree: (repoDir: string, branch: string, worktreesDir: string) => Promise<{ success: boolean; path?: string; error?: string }>
  addWorktree: (workspaceId: string, rootDir: string) => void
  runAction: (workspaceId: string, action: CustomAction) => void
  runBackgroundAction: (action: CustomAction) => void
  createSession: (workspaceId: string, initialCommand: string | undefined, processStatus: SpinUpAgent, treeIndex: number) => void
}

/**
 * Creates a git worktree for `workspaceId`, then (on success) runs the selected
 * creation actions and optionally spins up an agent session in the new tree.
 * Returns the IPC result so the caller can decide how to surface failures
 * (desktop dialog → alert; remote hook → no-op).
 */
export async function runWorktreeCreation(
  deps: WorktreeCreationDeps,
  workspaceId: string,
  { branch, selectedActionIds, spinUp }: WorktreeCreationInput,
): Promise<{ success: boolean; error?: string }> {
  const mainRoot = deps.workspace.trees[0].rootDir
  const result = await deps.createWorktree(mainRoot, branch, deps.worktreesDir)
  if (!result.success || !result.path) {
    return { success: false, error: result.error }
  }

  const newTreeIndex = deps.workspace.trees.length // the worktree will be added at this index
  deps.addWorktree(workspaceId, result.path)

  const selectedSet = new Set(selectedActionIds)
  for (const action of deps.workspace.customActions) {
    if (selectedSet.has(action.id)) {
      if (action.runInBackground) deps.runBackgroundAction(action)
      else deps.runAction(workspaceId, action)
    }
  }

  if (spinUp) {
    const initialCommand =
      spinUp === 'claude' ? 'claude' : spinUp === 'codex' ? 'codex' : spinUp === 'cursor' ? 'agent --force --model composer-2-fast' : undefined
    deps.createSession(workspaceId, initialCommand, spinUp, newTreeIndex)
  }

  return { success: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/renderer/src/utils/worktree-creation.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Refactor the desktop dialog handler to use it**

In `apps/desktop/src/renderer/src/components/Sidebar.tsx`, add the import near the other util imports (top of file):

```ts
import { runWorktreeCreation } from '../utils/worktree-creation'
```

Replace the entire `handleCreateWorktree` (lines 1363-1391) with:

```ts
  const handleCreateWorktree = async ({ branch: branchName, selectedActionIds, spinUp }: WorktreeDialogResult) => {
    if (!workspace || !activeWorkspaceId) return
    setShowWorktreeDialog(false)
    const result = await runWorktreeCreation(
      {
        workspace,
        worktreesDir: settings.worktreesDir,
        createWorktree: window.electronAPI.createWorktree,
        addWorktree,
        runAction,
        runBackgroundAction,
        createSession: (wid, cmd, status, idx) => createSession(wid, cmd, undefined, undefined, undefined, status, undefined, idx),
      },
      activeWorkspaceId,
      { branch: branchName, selectedActionIds, spinUp },
    )
    if (!result.success) window.alert(`Failed to create worktree:\n${result.error}`)
  }
```

- [ ] **Step 6: Typecheck the desktop**

Run: `cd apps/desktop && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/utils/worktree-creation.ts apps/desktop/src/renderer/src/utils/worktree-creation.test.ts apps/desktop/src/renderer/src/components/Sidebar.tsx
git commit -m "refactor(desktop): extract runWorktreeCreation shared by dialog + remote

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GWwZXGRBboyM3AbXqYe68C"
```

---

### Task 5: Desktop renderer — `useRemoteWorktree` hook + wire in App

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/useRemoteWorktree.ts`
- Modify: `apps/desktop/src/renderer/src/App.tsx:19,91`

**Interfaces:**
- Consumes: `electronAPI.onRemoteCreateWorktree` (Task 3), `runWorktreeCreation` (Task 4), `useAppStore` store actions (`workspaces`, `settings`, `addWorktree`, `runAction`, `createSession`).
- Produces: `export function useRemoteWorktree(): void`.

- [ ] **Step 1: Create the hook**

Create `apps/desktop/src/renderer/src/hooks/useRemoteWorktree.ts`:

```ts
import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'
import { runWorktreeCreation } from '../utils/worktree-creation'

/**
 * Creates a git worktree triggered from the web remote control. The bridge
 * (main) forwards a `remote-create-worktree` IPC event with the normalized
 * payload; we run the same flow as the desktop dialog via runWorktreeCreation.
 *
 * Background actions run interactively here (runAction with runInBackground
 * cleared): the headless background machinery (toast state, running-set) lives
 * in the Sidebar component and is not reachable from this top-level hook. This
 * matches what runBackgroundAction already does for claude/codex/cursor.
 *
 * Failures are silent on the web side (fire-and-forget); the desktop dialog
 * path is the only one that alerts.
 */
export function useRemoteWorktree(): void {
  useEffect(() => {
    return window.electronAPI.onRemoteCreateWorktree(({ workspaceId, branch, selectedActionIds, spinUp }) => {
      const state = useAppStore.getState()
      const workspace = state.workspaces[workspaceId]
      if (!workspace) return
      void runWorktreeCreation(
        {
          workspace,
          worktreesDir: state.settings.worktreesDir,
          createWorktree: window.electronAPI.createWorktree,
          addWorktree: state.addWorktree,
          runAction: state.runAction,
          runBackgroundAction: (action) => state.runAction(workspaceId, { ...action, runInBackground: false }),
          createSession: (wid, cmd, status, idx) => state.createSession(wid, cmd, undefined, undefined, undefined, status, undefined, idx),
        },
        workspaceId,
        { branch, selectedActionIds, spinUp },
      )
    })
  }, [])
}
```

- [ ] **Step 2: Wire the hook in App.tsx**

In `apps/desktop/src/renderer/src/App.tsx`, after the `useRemoteActions` import (line 19), add:

```ts
import { useRemoteWorktree } from './hooks/useRemoteWorktree'
```

After the `useRemoteActions()` call (line 91), add:

```ts
  useRemoteWorktree()
```

- [ ] **Step 3: Typecheck the desktop**

Run: `cd apps/desktop && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/useRemoteWorktree.ts apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(desktop): useRemoteWorktree runs web-triggered worktree creation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GWwZXGRBboyM3AbXqYe68C"
```

---

### Task 6: Web lib — agent list + payload builder + tests

**Files:**
- Modify: `apps/web/src/lib/actions.ts`
- Test: `apps/web/src/lib/actions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SpinUpAgent = 'terminal' | 'claude' | 'codex' | 'cursor'
  export interface SpinUpOption { id: SpinUpAgent; label: string; icon: string }
  export const SPIN_UP_AGENTS: SpinUpOption[]
  export interface CreateWorktreePayload { workspaceId: string; branch: string; selectedActionIds: string[]; spinUp: SpinUpAgent | null }
  export function buildCreateWorktreePayload(workspaceId: string, branch: string, selectedActionIds: string[], spinUp: SpinUpAgent | null): CreateWorktreePayload
  ```
- Consumes: nothing new (pure module).

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/lib/actions.test.ts`:

```ts
import { SPIN_UP_AGENTS, buildCreateWorktreePayload } from './actions'

describe('SPIN_UP_AGENTS', () => {
  it('lists the four agents matching the desktop dialog', () => {
    expect(SPIN_UP_AGENTS.map((a) => a.id)).toEqual(['terminal', 'claude', 'codex', 'cursor'])
  })
})

describe('buildCreateWorktreePayload', () => {
  it('trims the branch and passes through the rest', () => {
    expect(buildCreateWorktreePayload('w1', '  feature/x  ', ['a1'], 'claude')).toEqual({
      workspaceId: 'w1',
      branch: 'feature/x',
      selectedActionIds: ['a1'],
      spinUp: 'claude',
    })
  })

  it('accepts a null spinUp and empty actions', () => {
    expect(buildCreateWorktreePayload('w2', 'b', [], null)).toEqual({
      workspaceId: 'w2',
      branch: 'b',
      selectedActionIds: [],
      spinUp: null,
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && bun test src/lib/actions.test.ts`
Expected: FAIL — `SPIN_UP_AGENTS`/`buildCreateWorktreePayload` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `apps/web/src/lib/actions.ts`:

```ts
export type SpinUpAgent = 'terminal' | 'claude' | 'codex' | 'cursor'

export interface SpinUpOption {
  id: SpinUpAgent
  label: string
  icon: string
}

// The spin-up options offered in the worktree dialog, matching the desktop list
// (icons use the same DynamicIcon tokens).
export const SPIN_UP_AGENTS: SpinUpOption[] = [
  { id: 'terminal', label: 'Terminal', icon: '__terminal__' },
  { id: 'claude', label: 'Claude Code', icon: '__claude__' },
  { id: 'codex', label: 'Codex', icon: '__openai__' },
  { id: 'cursor', label: 'Cursor', icon: '__cursor__' },
]

export interface CreateWorktreePayload {
  workspaceId: string
  branch: string
  selectedActionIds: string[]
  spinUp: SpinUpAgent | null
}

/** Builds the `createWorktree` command payload, trimming the branch name. */
export function buildCreateWorktreePayload(
  workspaceId: string,
  branch: string,
  selectedActionIds: string[],
  spinUp: SpinUpAgent | null,
): CreateWorktreePayload {
  return { workspaceId, branch: branch.trim(), selectedActionIds, spinUp }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && bun test src/lib/actions.test.ts`
Expected: PASS (existing + 3 new tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/actions.ts apps/web/src/lib/actions.test.ts
git commit -m "feat(web): spin-up agent list + createWorktree payload builder

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GWwZXGRBboyM3AbXqYe68C"
```

---

### Task 7: Web — `WorktreeDialog` component

**Files:**
- Create: `apps/web/src/components/WorktreeDialog.tsx`

**Interfaces:**
- Consumes: `SafeAction`, `SpinUpAgent`, `SPIN_UP_AGENTS` from `@/lib/actions`; `DynamicIcon` from `./DynamicIcon`.
- Produces:
  ```ts
  export interface WorktreeDialogResult { branch: string; selectedActionIds: string[]; spinUp: SpinUpAgent | null }
  export function WorktreeDialog(props: {
    workspaceName: string
    actions: SafeAction[]
    onConfirm: (result: WorktreeDialogResult) => void
    onCancel: () => void
  }): JSX.Element
  ```

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/WorktreeDialog.tsx`:

```tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import { DynamicIcon } from './DynamicIcon'
import { SPIN_UP_AGENTS, type SafeAction, type SpinUpAgent } from '@/lib/actions'

export interface WorktreeDialogResult {
  branch: string
  selectedActionIds: string[]
  spinUp: SpinUpAgent | null
}

// 1:1 port of the desktop WorktreeDialog, themed with shadcn tokens: a branch
// name input, multi-select "Run on creation" action cards, and a single-select
// "Spin up on creation" agent picker.
export function WorktreeDialog({
  workspaceName,
  actions,
  onConfirm,
  onCancel,
}: {
  workspaceName: string
  actions: SafeAction[]
  onConfirm: (result: WorktreeDialogResult) => void
  onCancel: () => void
}) {
  const [branch, setBranch] = useState('')
  const [selectedActionIds, setSelectedActionIds] = useState<Set<string>>(() => new Set())
  const [spinUp, setSpinUp] = useState<SpinUpAgent | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const toggleAction = (id: string) => {
    setSelectedActionIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (branch.trim()) onConfirm({ branch: branch.trim(), selectedActionIds: [...selectedActionIds], spinUp })
  }

  const OptionCard = ({
    selected,
    onClick,
    icon,
    label,
  }: {
    selected: boolean
    onClick: () => void
    icon: React.ReactNode
    label: string
  }) => (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-9 items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-xs font-medium transition-colors ${
        selected ? 'border-primary bg-accent text-accent-foreground' : 'border-border bg-muted/40 text-muted-foreground'
      }`}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{icon}</span>
      <span>{label}</span>
    </button>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-[360px] rounded-xl border border-border bg-sidebar p-6 shadow-2xl"
      >
        <h2 className="mb-1 text-lg font-semibold text-foreground">New Worktree</h2>
        <p className="mb-4 truncate text-xs text-muted-foreground">{workspaceName}</p>

        <input
          ref={inputRef}
          type="text"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="Branch name"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none"
        />

        {actions.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Run on creation</div>
            <div className="flex flex-wrap gap-2">
              {actions.map((action) => (
                <OptionCard
                  key={action.id}
                  selected={selectedActionIds.has(action.id)}
                  onClick={() => toggleAction(action.id)}
                  icon={<DynamicIcon name={action.icon || '__terminal__'} size={16} />}
                  label={action.name}
                />
              ))}
            </div>
          </div>
        )}

        <div className="mt-4">
          <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Spin up on creation</div>
          <div className="flex flex-wrap gap-2">
            {SPIN_UP_AGENTS.map((agent) => (
              <OptionCard
                key={agent.id}
                selected={spinUp === agent.id}
                onClick={() => setSpinUp(spinUp === agent.id ? null : agent.id)}
                icon={<DynamicIcon name={agent.icon} size={16} />}
                label={agent.label}
              />
            ))}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!branch.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck the web**

Run: `cd apps/web && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Lint the web**

Run: `cd apps/web && bun run lint`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/WorktreeDialog.tsx
git commit -m "feat(web): WorktreeDialog component (1:1 desktop port)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GWwZXGRBboyM3AbXqYe68C"
```

---

### Task 8: Web — sidebar trigger, dialog wiring, and auto-attach arm

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx` (SafeWorkspace interface; AppSidebar props; per-workspace "+ New worktree" row + dialog)
- Modify: `apps/web/src/app/page.tsx` (thread arm callback into `AppSidebar`)

**Interfaces:**
- Consumes: `WorktreeDialog`, `WorktreeDialogResult` (Task 7); `buildCreateWorktreePayload`, `SafeAction` (Tasks 6); `anyApi.remote.sendCommand`.
- Produces: `AppSidebar` gains an `onWorktreeFired: () => void` prop.

- [ ] **Step 1: Add `customActions` to the web SafeWorkspace + imports**

In `apps/web/src/components/Sidebar.tsx`, add to the imports at the top (the file already imports `useCallback, useRef, useState` from `'react'` on line 2 and `useConvex, useQuery` + `anyApi` on lines 3-4 — reuse those, don't re-import):

```ts
import { WorktreeDialog, type WorktreeDialogResult } from './WorktreeDialog'
import { buildCreateWorktreePayload, type SafeAction } from '@/lib/actions'
```

Extend the `SafeWorkspace` interface (lines 24-31) with the actions field:

```ts
interface SafeWorkspace {
  id: string
  name: string
  color: string
  emoji?: string
  trees: SafeTree[]
  activeTreeIndex: number
  customActions?: SafeAction[]
}
```

- [ ] **Step 2: Add the `onWorktreeFired` prop + dialog state to AppSidebar**

In `apps/web/src/components/Sidebar.tsx`, change the `AppSidebar` signature to accept `onWorktreeFired`:

```tsx
export function AppSidebar({
  token,
  selectedId,
  onSelect,
  onClose,
  onWorktreeFired,
}: {
  token: string
  selectedId: string | null
  onSelect: (sessionId: string) => void
  onClose: (sessionId: string) => void
  onWorktreeFired: () => void
}) {
```

Immediately after the existing `const [killed, setKilled] = useState<Set<string>>(new Set())` line, add the dialog state and submit handler:

```tsx
  // Which workspace's "New worktree" dialog is open (null = closed).
  const [worktreeFor, setWorktreeFor] = useState<SafeWorkspace | null>(null)

  const submitWorktree = useCallback(
    (workspaceId: string, { branch, selectedActionIds, spinUp }: WorktreeDialogResult) => {
      setWorktreeFor(null)
      void convex.mutation(anyApi.remote.sendCommand, {
        token,
        sessionId: '',
        kind: 'createWorktree',
        payload: buildCreateWorktreePayload(workspaceId, branch, selectedActionIds, spinUp),
      })
      onWorktreeFired()
    },
    [convex, token, onWorktreeFired],
  )
```

- [ ] **Step 3: Render the "+ New worktree" row per workspace**

In `apps/web/src/components/Sidebar.tsx`, inside the workspace `.map((ws) => ...)`, after the closing `</SidebarGroupContent>` and before `</SidebarGroup>`, add the trigger row:

```tsx
            <SidebarGroupContent>
              <button
                type="button"
                onClick={() => setWorktreeFor(ws)}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-sidebar-border py-1 text-xs text-muted-foreground transition-opacity hover:opacity-80"
              >
                <span>+</span>
                <span>New worktree</span>
              </button>
            </SidebarGroupContent>
```

- [ ] **Step 4: Render the dialog**

In `apps/web/src/components/Sidebar.tsx`, just before the closing `</Sidebar>` tag (after `</SidebarContent>`), add:

```tsx
      {worktreeFor && (
        <WorktreeDialog
          workspaceName={`${worktreeFor.emoji ? `${worktreeFor.emoji} ` : ''}${worktreeFor.name}`}
          actions={worktreeFor.customActions ?? []}
          onConfirm={(result) => submitWorktree(worktreeFor.id, result)}
          onCancel={() => setWorktreeFor(null)}
        />
      )}
```

- [ ] **Step 5: Thread the arm callback in page.tsx**

In `apps/web/src/app/page.tsx`, the existing `onActionFired` already sets `pendingAttach`. Pass the same arm into `AppSidebar`. Update the `<AppSidebar ... />` (lines 54-59) to add the prop:

```tsx
      <AppSidebar
        token={token}
        selectedId={selected}
        onSelect={setSelected}
        onClose={(sid) => setSelected((cur) => (cur === sid ? null : cur))}
        onWorktreeFired={onActionFired}
      />
```

- [ ] **Step 6: Typecheck the web**

Run: `cd apps/web && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Lint the web**

Run: `cd apps/web && bun run lint`
Expected: PASS.

- [ ] **Step 8: Manual smoke (optional, requires desktop + web running)**

With the desktop app connected to the remote and the web app open: tap "+ New worktree" on a workspace, enter a branch, pick an action + Claude Code, Create. Expect the desktop to create the worktree and spin up Claude, and the web view to switch to the new session within ~8s.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx apps/web/src/app/page.tsx
git commit -m "feat(web): per-workspace New worktree dialog + auto-attach

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GWwZXGRBboyM3AbXqYe68C"
```

---

## Notes for the implementer

- **`useCallback`/`useState` imports (web Sidebar):** the file already imports `useCallback, useRef, useState` from `'react'` (line 2) and `useConvex, useQuery` + `anyApi` (lines 3-4). Reuse those; do not add duplicate imports.
- **`createSession` signature:** the real store signature is `createSession(workspaceId, initialCommand?, actionId?, actionIcon?, actionName?, processStatus?, launchProfile?, treeIndex?)`. The deps adapter in Tasks 4 & 5 maps the simplified 4-arg form onto it by passing `undefined` for `actionId/actionIcon/actionName/launchProfile`.
- **Index lag:** after editing files, the codegraph watcher lags ~500ms — don't re-query it in the same turn.
```
