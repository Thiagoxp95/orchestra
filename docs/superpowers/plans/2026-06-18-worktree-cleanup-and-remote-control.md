# Bulk Worktree Cleanup + Auto `/remote-control` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a workspace-header button that bulk-removes finished worktrees (Linear in staging/production OR PR closed/merged), and auto-run `/remote-control` on every new blank interactive Claude session.

**Architecture:** Three isolated changes. (1) Inject `/remote-control` as the positional prompt in the existing `buildActionCommand` claude branch (`shared/action-utils.ts`). (2) A new pure eligibility helper `isWorktreeCleanupEligible` (`renderer/src/utils/worktree-cleanup.ts`) with unit tests. (3) Wire a `CleanIcon` button + `handleCleanupWorktrees` + lightweight toasts into the workspace header in `Sidebar.tsx`, consuming the helper and existing polled `treePRs`/`treeLinearIssues` state.

**Tech Stack:** TypeScript, React, Zustand store, Electron IPC (`window.electronAPI`), Vitest, `hugeicons-react`.

## Global Constraints

- Working dir for all commands: `/Users/tedyeng1/Tedy/orchestra/apps/desktop`.
- Run a single test file: `npx vitest run <relative-path>` (no `test` npm script exists).
- Typecheck: `npm run typecheck` (runs `tsgo` over node + web tsconfigs).
- Tree index `0` is the main repo and must NEVER be removed by cleanup.
- PR states from `get-git-pr-info`: `OPEN | CLOSED | MERGED | DRAFT`.
- Linear "done" states matched on `state.name`, case-insensitive, exact equality to `staging` or `production`.
- Bulk cleanup: no confirmation dialog; force-delete anyway; destruction-action failures toast and proceed (never abort the worktree or batch).
- `/remote-control` injection applies ONLY to blank interactive Claude actions (`actionType === 'claude'`, not `printMode`, no `command`).

---

### Task 1: Auto `/remote-control` for blank interactive Claude sessions

**Files:**
- Modify: `src/shared/action-utils.ts` (the `actionType === 'claude'` branch in `buildActionCommand`, ~lines 90-98; add an exported constant near line 6)
- Test: `src/shared/action-utils.test.ts` (update the existing Claude default test ~lines 52-58; add new cases)

**Interfaces:**
- Consumes: existing `buildActionCommand(action: CustomAction)`, `shellQuote(value: string)`, `getClaudeShellCommandBinary()`.
- Produces: exported `CLAUDE_REMOTE_CONTROL_COMMAND = '/remote-control'`. For a blank interactive Claude action, `buildActionCommand` returns `claude --dangerously-skip-permissions '/remote-control'`.

- [ ] **Step 1: Update + add failing tests**

In `src/shared/action-utils.test.ts`, add `CLAUDE_REMOTE_CONTROL_COMMAND` to the import block from `./action-utils` (line 2-12). Replace the existing test "builds the default Claude shell command" (lines 52-58) with the block below and add the three following tests right after it:

```ts
  it('exports the remote-control slash command constant', () => {
    expect(CLAUDE_REMOTE_CONTROL_COMMAND).toBe('/remote-control')
  })

  it('auto-runs /remote-control for a blank interactive Claude session', () => {
    expect(buildActionCommand(makeAction({
      actionType: 'claude',
      icon: '__claude__',
      name: 'Claude',
    }))).toBe("claude --dangerously-skip-permissions '/remote-control'")
  })

  it('does not inject /remote-control when the Claude action has a prompt', () => {
    expect(buildActionCommand(makeAction({
      actionType: 'claude',
      command: 'review the diff',
    }))).toBe("claude --dangerously-skip-permissions 'review the diff'")
  })

  it('does not inject /remote-control for print-mode Claude actions', () => {
    expect(buildActionCommand(makeAction({
      actionType: 'claude',
      printMode: true,
    }))).toBe('claude -p --dangerously-skip-permissions')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/action-utils.test.ts`
Expected: FAIL — `CLAUDE_REMOTE_CONTROL_COMMAND` is not exported, and the blank-Claude case still returns `claude --dangerously-skip-permissions`.

- [ ] **Step 3: Implement the constant + injection**

In `src/shared/action-utils.ts`, add after line 6 (`export const CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW = ...`):

```ts
// Blank interactive Claude instances auto-run this slash command on startup so
// new sessions are immediately controllable from the mobile remote.
export const CLAUDE_REMOTE_CONTROL_COMMAND = '/remote-control'
```

Replace the claude branch body (currently lines ~90-98):

```ts
  if (actionType === 'claude') {
    const parts = [getClaudeShellCommandBinary()]
    if (action.printMode) parts.push('-p')
    if (action.agentModel?.trim()) parts.push('--model', shellToken(action.agentModel.trim()))
    if (action.agentReasoningEffort) parts.push('--effort', action.agentReasoningEffort)
    parts.push('--dangerously-skip-permissions')
    if (action.command) parts.push(shellQuote(action.command))
    return parts.join(' ')
  }
```

with:

```ts
  if (actionType === 'claude') {
    const parts = [getClaudeShellCommandBinary()]
    if (action.printMode) parts.push('-p')
    if (action.agentModel?.trim()) parts.push('--model', shellToken(action.agentModel.trim()))
    if (action.agentReasoningEffort) parts.push('--effort', action.agentReasoningEffort)
    parts.push('--dangerously-skip-permissions')
    if (action.command?.trim()) {
      parts.push(shellQuote(action.command))
    } else if (!action.printMode) {
      // Blank interactive Claude instance — auto-run /remote-control on startup.
      parts.push(shellQuote(CLAUDE_REMOTE_CONTROL_COMMAND))
    }
    return parts.join(' ')
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/action-utils.test.ts`
Expected: PASS (all cases, including the unchanged model/effort and codex/cursor tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/action-utils.ts src/shared/action-utils.test.ts
git commit -m "feat(desktop): auto-run /remote-control on new blank Claude sessions"
```

---

### Task 2: Pure worktree-cleanup eligibility helper

**Files:**
- Create: `src/renderer/src/utils/worktree-cleanup.ts`
- Test: `src/renderer/src/utils/worktree-cleanup.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface WorktreeCleanupInput {
    treeIndex: number
    pr?: { state: string } | null
    linearIssue?: { state: { name: string } } | null
  }
  function isWorktreeCleanupEligible(input: WorktreeCleanupInput): boolean
  ```
  Returns `false` for `treeIndex === 0`; otherwise `true` if PR state (upper-cased) is `CLOSED`/`MERGED`, OR Linear `state.name` (trimmed, lower-cased) is `staging`/`production`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/utils/worktree-cleanup.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isWorktreeCleanupEligible } from './worktree-cleanup'

describe('isWorktreeCleanupEligible', () => {
  it('never removes the main repo (index 0), even when its PR is merged', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 0, pr: { state: 'MERGED' } })).toBe(false)
  })

  it('is eligible when the PR is closed or merged', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 1, pr: { state: 'CLOSED' } })).toBe(true)
    expect(isWorktreeCleanupEligible({ treeIndex: 1, pr: { state: 'MERGED' } })).toBe(true)
    expect(isWorktreeCleanupEligible({ treeIndex: 1, pr: { state: 'merged' } })).toBe(true)
  })

  it('is not eligible for open or draft PRs', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 1, pr: { state: 'OPEN' } })).toBe(false)
    expect(isWorktreeCleanupEligible({ treeIndex: 1, pr: { state: 'DRAFT' } })).toBe(false)
  })

  it('is eligible when the Linear ticket is in staging or production (case-insensitive)', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: 'Staging' } } })).toBe(true)
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: 'production' } } })).toBe(true)
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: ' Production ' } } })).toBe(true)
  })

  it('is not eligible for other Linear states', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 2, linearIssue: { state: { name: 'In Progress' } } })).toBe(false)
  })

  it('is eligible if either condition holds (PR merged even when Linear is not done)', () => {
    expect(isWorktreeCleanupEligible({
      treeIndex: 3,
      pr: { state: 'MERGED' },
      linearIssue: { state: { name: 'In Progress' } },
    })).toBe(true)
  })

  it('is not eligible with no PR and no Linear ticket', () => {
    expect(isWorktreeCleanupEligible({ treeIndex: 4 })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/utils/worktree-cleanup.test.ts`
Expected: FAIL — `Cannot find module './worktree-cleanup'`.

- [ ] **Step 3: Implement the helper**

Create `src/renderer/src/utils/worktree-cleanup.ts`:

```ts
export interface WorktreeCleanupInput {
  /** Index of the tree within `workspace.trees`. Index 0 is the main repo. */
  treeIndex: number
  /** Latest polled PR info for the tree, if any. */
  pr?: { state: string } | null
  /** Latest polled Linear issue for the tree, if any. */
  linearIssue?: { state: { name: string } } | null
}

const DONE_LINEAR_STATES = ['staging', 'production']

/**
 * A worktree is eligible for bulk cleanup when its work is "done":
 * its PR is closed/merged, or its Linear ticket is in staging/production.
 * The main repo (index 0) is never eligible.
 */
export function isWorktreeCleanupEligible(input: WorktreeCleanupInput): boolean {
  if (input.treeIndex === 0) return false

  const prState = input.pr?.state?.toUpperCase()
  if (prState === 'CLOSED' || prState === 'MERGED') return true

  const linearState = input.linearIssue?.state?.name?.trim().toLowerCase()
  if (linearState && DONE_LINEAR_STATES.includes(linearState)) return true

  return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/utils/worktree-cleanup.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/utils/worktree-cleanup.ts src/renderer/src/utils/worktree-cleanup.test.ts
git commit -m "feat(desktop): add worktree cleanup eligibility helper"
```

---

### Task 3: Wire the cleanup button into the workspace header

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`
  - imports (~line 9): add `CleanIcon`
  - new import: `isWorktreeCleanupEligible` from `../utils/worktree-cleanup`
  - new local state + helpers near the other delete handlers (~line 1390-1464)
  - new button in the workspace header (~line 1658, before the gear button)
  - new toast render block (~line 2526, beside `actionToasts`)

**Interfaces:**
- Consumes: `isWorktreeCleanupEligible` (Task 2); existing store action `removeWorktree(wsId, treeIndex)` (already bound at line 671); existing `setDeletingWorktree`, `deletingWorktrees`, `workspaces`, `treePRs`, `treeLinearIssues`, `wsColor`, `txtColor`; IPC `window.electronAPI.runBackgroundCommand`, `killTerminal`, `removeWorktree`.
- Produces: header button calling `handleCleanupWorktrees(ws.id)`; user-visible only — no exports.

- [ ] **Step 1: Add the `CleanIcon` import**

In `src/renderer/src/components/Sidebar.tsx` line 9, change:

```ts
import { Settings01Icon } from 'hugeicons-react'
```

to:

```ts
import { Settings01Icon, CleanIcon } from 'hugeicons-react'
```

Then add near the other util imports (after the `worktree-display` import; search for `from '../utils/`):

```ts
import { isWorktreeCleanupEligible } from '../utils/worktree-cleanup'
```

- [ ] **Step 2: Add cleanup state + handler**

In the component body, directly above `const forceDeleteWorktree = async` (line ~1392), insert:

```ts
  const [cleanupToasts, setCleanupToasts] = useState<{ id: string; message: string }[]>([])
  const [cleaningWorkspaces, setCleaningWorkspaces] = useState<Set<string>>(new Set())

  const showCleanupToast = (message: string) => {
    const id = `cleanup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setCleanupToasts((prev) => [...prev, { id, message }])
    setTimeout(() => {
      setCleanupToasts((prev) => prev.filter((t) => t.id !== id))
    }, 3500)
  }

  const handleCleanupWorktrees = async (wsId: string) => {
    if (cleaningWorkspaces.has(wsId)) return
    const ws = workspaces[wsId]
    if (!ws) return

    const wsPRs = treePRs[wsId] ?? {}
    const wsIssues = treeLinearIssues[wsId] ?? {}

    // Snapshot eligible trees (the helper already excludes the main repo at index 0).
    const eligible = ws.trees
      .map((tree, treeIndex) => ({ tree, treeIndex }))
      .filter(({ treeIndex }) =>
        isWorktreeCleanupEligible({
          treeIndex,
          pr: wsPRs[treeIndex],
          linearIssue: wsIssues[treeIndex],
        }),
      )

    if (eligible.length === 0) {
      showCleanupToast('No finished worktrees to clean up')
      return
    }

    setCleaningWorkspaces((prev) => new Set(prev).add(wsId))
    try {
      const destructionActions = ws.customActions.filter((a) => a.runOnWorktreeDestruction)
      const mainRoot = ws.trees[0].rootDir

      // Delete in descending index order so lower indices stay valid as the
      // store splices trees out and re-indexes.
      const ordered = [...eligible].sort((a, b) => b.treeIndex - a.treeIndex)

      for (const { tree, treeIndex } of ordered) {
        const key = `${wsId}:${treeIndex}`
        setDeletingWorktree(key, true)
        try {
          // Run destruction actions — failures toast and proceed anyway.
          for (const action of destructionActions) {
            const result = await window.electronAPI.runBackgroundCommand(tree.rootDir, action.command)
            if (!result.success) {
              showCleanupToast(`${action.name || action.command} failed`)
            }
          }
          // Kill sessions in this worktree.
          for (const sid of tree.sessionIds) {
            window.electronAPI.killTerminal(sid)
          }
          // Force-remove the git worktree (the IPC already forces); ignore failures.
          await window.electronAPI.removeWorktree(mainRoot, tree.rootDir)
        } catch {
          // Force-delete-anyway: swallow and still drop it from the store.
        } finally {
          removeWorktree(wsId, treeIndex)
          setDeletingWorktree(key, false)
        }
      }
    } finally {
      setCleaningWorkspaces((prev) => {
        const next = new Set(prev)
        next.delete(wsId)
        return next
      })
    }
  }
```

- [ ] **Step 3: Add the header button (left of the gear)**

In the workspace header, immediately before the gear button block (`{isActiveWs && (` … `<Settings01Icon size={14} />` at lines ~1658-1666), insert a second `{isActiveWs && (...)}` block so the broom renders to the LEFT of the gear:

```tsx
                  {isActiveWs && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleCleanupWorktrees(ws.id) }}
                      disabled={cleaningWorkspaces.has(ws.id)}
                      className="opacity-50 hover:!opacity-100 transition-opacity disabled:opacity-30"
                      style={{ color: txtColor }}
                      title="Clean up finished worktrees (Linear staging/production or closed/merged PR)"
                    >
                      <CleanIcon size={14} />
                    </button>
                  )}
```

The existing gear button block stays immediately after it, unchanged.

- [ ] **Step 4: Add the cleanup toast render block**

Immediately before the `actionToasts` render block (line ~2526, `{actionToasts.length > 0 && (`), insert:

```tsx
      {cleanupToasts.length > 0 && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none items-center">
          {cleanupToasts.map((t) => (
            <div
              key={t.id}
              className="pointer-events-auto flex items-center gap-2.5 px-4 py-2.5 rounded-xl shadow-lg animate-toast-in"
              style={{
                backgroundColor: wsColor,
                border: `1px solid ${isLightColor(wsColor) ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.1)'}`,
              }}
            >
              <span className="text-sm font-medium" style={{ color: txtColor }}>{t.message}</span>
            </div>
          ))}
        </div>
      )}
```

(`isLightColor` is already imported in this file — it is used by the existing `actionToasts` block.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `tsgo` flags an unused import or a missing binding, fix it — e.g. confirm `treeLinearIssues`, `treePRs`, `setDeletingWorktree`, `deletingWorktrees`, `removeWorktree`, `workspaces`, `wsColor`, `txtColor` are all in scope in the component; they are bound earlier in the file.)

- [ ] **Step 6: Manual verification (dev build)**

Run the app: from `/Users/tedyeng1/Tedy/orchestra/apps/desktop`, `npm run dev` (or invoke the `desktop:dev` skill).
Verify:
1. The broom icon appears left of the gear in the active workspace header.
2. Create/locate worktrees: one with a closed or merged PR, one whose Linear ticket is Staging/Production, and a control with an open PR + non-staging Linear.
3. Click the broom → the merged/closed-PR and staging/production worktrees are removed (including any with uncommitted changes); the control remains. Main repo (index 0) is untouched.
4. With a `runOnWorktreeDestruction` action that exits non-zero, confirm a toast appears and cleanup still proceeds.
5. With no eligible worktrees, clicking shows the "No finished worktrees to clean up" toast.
6. Cmd+N (or a NavBar new-Claude button) launches `claude --dangerously-skip-permissions '/remote-control'` and Claude runs the command on startup.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "feat(desktop): add bulk worktree cleanup button to workspace header"
```

---

## Self-Review Notes

- **Spec coverage:** Feature 1 button/placement/criteria/force-delete/no-confirm/destruction-action-toast/descending-delete → Tasks 2 + 3. Feature 2 blank-interactive injection + side-effect awareness → Task 1. All spec sections map to a task.
- **Type consistency:** `isWorktreeCleanupEligible` signature (Task 2) matches its call site (Task 3); `CLAUDE_REMOTE_CONTROL_COMMAND` defined and consumed in Task 1; `treePRs` value type `{ number; state; title; url }` and `treeLinearIssues` value type `LinearIssueSummary` (`state.name`) match the helper's optional `pr.state` / `linearIssue.state.name` inputs.
- **Known accepted side effects (from spec):** injected Claude command no longer matches `CLAUDE_INTERACTIVE_COMMAND_PREVIEW`, so the session registers as an agent launch and bypasses the experimental warm pool — intentional, no code change.
