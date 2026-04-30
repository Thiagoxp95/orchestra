# Linear Ticket Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Linear-issue icon to the right of the existing PR icon in each sidebar worktree row, showing the matched issue's state at a glance with hover/click affordances.

**Architecture:** A pure regex helper extracts a Linear-style identifier (e.g. `ENG-4504`) from a worktree's branch name. The renderer's existing `linear-client` is extended with `fetchIssueByIdentifier`, which uses Linear's GraphQL `issue(id)` endpoint (accepts the human identifier). `Sidebar.tsx` polls every 60s, dedupes fetches per identifier with a 5-minute in-memory TTL cache, and renders the new `LinearIssueIcon` (logo + state-colored dot) when a tree's branch matches and the workspace has Linear connected.

**Tech Stack:** React 19, TypeScript, vitest, Tailwind CSS v4, Linear GraphQL API (existing client at `apps/desktop/src/renderer/src/utils/linear-client.ts`).

**Spec:** `docs/superpowers/specs/2026-04-30-linear-ticket-icon-design.md`

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `apps/desktop/src/shared/linear-types.ts` | modify | Add `LinearIssueSummary` |
| `apps/desktop/src/renderer/src/utils/linear-branch.ts` | create | `extractLinearIdentifier(branch)` |
| `apps/desktop/src/renderer/src/utils/linear-branch.test.ts` | create | Unit tests for the extractor |
| `apps/desktop/src/renderer/src/utils/linear-client.ts` | modify | Add `fetchIssueByIdentifier` |
| `apps/desktop/src/renderer/src/components/Sidebar.tsx` | modify | `LinearIssueIcon` component, polling effect, state, render |

**Test command (from repo root):** `cd apps/desktop && bunx vitest run <test-file>`
**Typecheck:** `bun run typecheck` (root)
**Lint:** `bun run lint` (root)

---

### Task 1: Add `LinearIssueSummary` type

**Files:**
- Modify: `apps/desktop/src/shared/linear-types.ts`

- [ ] **Step 1: Open the file and append the new type at the bottom**

```ts
export interface LinearIssueSummary {
  identifier: string  // e.g., "ENG-4504"
  title: string
  url: string
  state: {
    name: string   // e.g., "In Progress"
    color: string  // hex, e.g., "#f2c94c"
    type: string   // backlog | unstarted | started | completed | cancelled
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no usages yet, type compiles cleanly)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/shared/linear-types.ts
git commit -m "feat(desktop): add LinearIssueSummary type"
```

---

### Task 2: Create `extractLinearIdentifier` (TDD)

**Files:**
- Create: `apps/desktop/src/renderer/src/utils/linear-branch.ts`
- Create: `apps/desktop/src/renderer/src/utils/linear-branch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/utils/linear-branch.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { extractLinearIdentifier } from './linear-branch'

describe('extractLinearIdentifier', () => {
  it('extracts and uppercases a whole-branch identifier', () => {
    expect(extractLinearIdentifier('eng-4504')).toBe('ENG-4504')
  })

  it('extracts identifier from a Linear-style slug branch', () => {
    expect(extractLinearIdentifier('tedy/eng-4504-add-linear-icon')).toBe('ENG-4504')
  })

  it('extracts identifier preceded by a slash', () => {
    expect(extractLinearIdentifier('feat/eng-4504')).toBe('ENG-4504')
  })

  it('extracts identifier followed by a dash', () => {
    expect(extractLinearIdentifier('eng-4504-foo')).toBe('ENG-4504')
  })

  it('normalizes mixed case to uppercase', () => {
    expect(extractLinearIdentifier('Eng-4504')).toBe('ENG-4504')
    expect(extractLinearIdentifier('ENG-4504')).toBe('ENG-4504')
  })

  it('returns null for branches with no identifier', () => {
    expect(extractLinearIdentifier('main')).toBeNull()
    expect(extractLinearIdentifier('feature/no-id')).toBeNull()
    expect(extractLinearIdentifier('release-2026')).toBeNull()
  })

  it('rejects single-letter prefixes', () => {
    expect(extractLinearIdentifier('q-2-recap')).toBeNull()
    expect(extractLinearIdentifier('notes/q-2-recap')).toBeNull()
  })

  it('rejects mid-token false positives without boundaries', () => {
    expect(extractLinearIdentifier('releaseV2-2026')).toBeNull()
  })

  it('returns the first match when multiple identifiers exist', () => {
    expect(extractLinearIdentifier('tedy/eng-4504-fixes-dev-99')).toBe('ENG-4504')
  })

  it('returns null for empty string', () => {
    expect(extractLinearIdentifier('')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bunx vitest run src/renderer/src/utils/linear-branch.test.ts`
Expected: FAIL with module-not-found error for `./linear-branch`.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/desktop/src/renderer/src/utils/linear-branch.ts`:

```ts
const PATTERN = /(?:^|[/\-])([a-zA-Z]{2,8})-(\d+)(?=$|[/\-])/

export function extractLinearIdentifier(branch: string): string | null {
  const match = PATTERN.exec(branch)
  if (!match) return null
  return `${match[1].toUpperCase()}-${match[2]}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && bunx vitest run src/renderer/src/utils/linear-branch.test.ts`
Expected: PASS, all 10 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/utils/linear-branch.ts apps/desktop/src/renderer/src/utils/linear-branch.test.ts
git commit -m "feat(desktop): extract Linear identifier from branch names"
```

---

### Task 3: Add `fetchIssueByIdentifier` to `linear-client.ts`

**Files:**
- Modify: `apps/desktop/src/renderer/src/utils/linear-client.ts`

The existing `linear-client.ts` has no unit tests (its functions hit the live Linear API and are exercised in `IssueBoard`). We follow that pattern — manual verification later via the dev server.

- [ ] **Step 1: Add the import for the new type at the top of the file**

Open `apps/desktop/src/renderer/src/utils/linear-client.ts:1`. Replace:

```ts
import type { LinearTeam, LinearWorkflowState, LinearIssue, LinearBoardData } from '../../../shared/linear-types'
```

with:

```ts
import type { LinearTeam, LinearWorkflowState, LinearIssue, LinearBoardData, LinearIssueSummary } from '../../../shared/linear-types'
```

- [ ] **Step 2: Append the new function at the end of the file**

Add to the end of `apps/desktop/src/renderer/src/utils/linear-client.ts`:

```ts
export async function fetchIssueByIdentifier(
  apiKey: string,
  identifier: string,
): Promise<LinearIssueSummary | null> {
  try {
    const data = await linearQuery<{
      issue: {
        identifier: string
        title: string
        url: string
        state: { name: string; color: string; type: string }
      } | null
    }>(apiKey, `
      query($id: String!) {
        issue(id: $id) {
          identifier
          title
          url
          state {
            name
            color
            type
          }
        }
      }
    `, { id: identifier })
    if (!data.issue) return null
    return {
      identifier: data.issue.identifier,
      title: data.issue.title,
      url: data.issue.url,
      state: {
        name: data.issue.state.name,
        color: data.issue.state.color,
        type: data.issue.state.type,
      },
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/utils/linear-client.ts
git commit -m "feat(desktop): add fetchIssueByIdentifier to linear client"
```

---

### Task 4: Add `LinearIssueIcon` component to `Sidebar.tsx`

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx` (insert after `PRIcon` definition, ~line 83)

- [ ] **Step 1: Add the import for the new type**

Find the existing imports in `Sidebar.tsx`. Add `LinearIssueSummary` alongside other shared-type imports. Locate the import that pulls types from `../../../shared/types` (or similar) or add a new import line near the top of the file:

```ts
import type { LinearIssueSummary } from '../../../shared/linear-types'
```

(If the file has no existing import from `linear-types`, add one. Place it near other shared-type imports.)

- [ ] **Step 2: Insert the `LinearIssueIcon` component definition immediately after `PRIcon`**

Find the closing brace of `PRIcon` at `Sidebar.tsx:83`. Insert this block right after it (before `function getUpdatePreview`):

```tsx
function LinearIssueIcon({
  state,
  color,
  size = 12,
}: {
  state: LinearIssueSummary['state']
  color: string
  size?: number
}) {
  const dotSize = Math.max(4, Math.round(size / 2))
  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 100 100" fill={color} aria-hidden="true">
        <path d="M1.225 61.523a.846.846 0 0 1 1.596-.857l36.51 36.51a.846.846 0 0 1-.856 1.596C20.051 94.452 5.548 79.948 1.225 61.523ZM.002 46.889a.846.846 0 0 1 .319-.829L52.283 99.681a.846.846 0 0 1 .828-.318c2.756-.158 5.452-.53 8.08-1.099a.846.846 0 0 0 .443-1.572L2.557 38.355a.846.846 0 0 0-1.572.444C.409 41.436.037 44.133 0 46.889ZM4.918 27.284a.846.846 0 0 1 .123-.674l67.052 67.052a.846.846 0 0 1-.674.123 39.94 39.94 0 0 1-5.724-2.987.846.846 0 0 1-.259-2.08L9.085 21.302a.846.846 0 0 0-2.08.259 39.94 39.94 0 0 0-2.087 5.723ZM12.603 17.466a1.302 1.302 0 0 1-.029-1.84C21.78 5.797 34.643 0 49.001 0 76.072 0 98 21.928 98 49.001c0 14.358-5.796 27.221-15.625 36.428a1.302 1.302 0 0 1-1.84-.03L12.603 17.466Z" />
      </svg>
      <span
        className="absolute rounded-full"
        style={{
          width: dotSize,
          height: dotSize,
          right: -1,
          bottom: -1,
          backgroundColor: state.color,
          boxShadow: `0 0 0 1px ${color}`,
        }}
      />
    </span>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/Sidebar.tsx
git commit -m "feat(desktop): add LinearIssueIcon component"
```

---

### Task 5: Add state, refs, and polling effect to `Sidebar.tsx`

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx`

This task adds:
- `treeLinearIssues` state (mirroring `treePRs`)
- An `issueCacheRef` for the per-identifier 5-minute TTL cache
- A `decryptedKeyRef` so we don't decrypt the workspace API key on every tick
- A polling `useEffect` modeled on the PR effect at `Sidebar.tsx:716-746`

- [ ] **Step 1: Add the function and constant imports**

Locate the existing utility imports in `Sidebar.tsx` and add:

```ts
import { extractLinearIdentifier } from '../utils/linear-branch'
import { fetchIssueByIdentifier } from '../utils/linear-client'
```

(Place these near the existing utility imports; the order doesn't matter as long as they're at the top of the file.)

- [ ] **Step 2: Add the new state next to `treePRs`**

Find the `treePRs` state declaration (search for `setTreePRs`). Immediately after that `useState` line, add:

```ts
const [treeLinearIssues, setTreeLinearIssues] = useState<Record<string, Record<number, LinearIssueSummary>>>({})
```

- [ ] **Step 3: Add the two refs near other refs in the component**

Find `treeBranchesRef` (it's referenced in the existing PR effect). Immediately after it (or near other top-level refs), add:

```ts
const decryptedKeyRef = useRef<Record<string, { encrypted: string; plaintext: string }>>({})
const issueCacheRef = useRef<Record<string, { issue: LinearIssueSummary | null; fetchedAt: number }>>({})
```

You may need to add `useRef` to the React imports if it's not already there.

- [ ] **Step 4: Add the polling effect immediately after the PR polling effect**

Find the closing of the PR polling effect (search for `// Port scanning` — the effect just above it ends with `}, [sortedWorkspaces.map(...).join(',')])`).

Insert this new effect *between* the PR effect and the port-scanning effect:

```tsx
// Linear issue polling for workspaces with linearConfig
useEffect(() => {
  const ISSUE_TTL_MS = 5 * 60_000
  let cancelled = false

  const fetchLinearIssues = async () => {
    const currentBranches = treeBranchesRef.current
    for (const ws of sortedWorkspaces) {
      if (!ws.linearConfig) {
        // Workspace had Linear configured before but no longer — clear stale entries.
        setTreeLinearIssues((prev) => {
          if (!prev[ws.id]) return prev
          const next = { ...prev }
          delete next[ws.id]
          return next
        })
        continue
      }
      const branches = currentBranches[ws.id]
      if (!branches) continue

      // Decrypt key (cached).
      const cachedKey = decryptedKeyRef.current[ws.id]
      let plaintext: string
      if (cachedKey && cachedKey.encrypted === ws.linearConfig.apiKey) {
        plaintext = cachedKey.plaintext
      } else {
        try {
          plaintext = await window.electronAPI.linearDecryptKey(ws.linearConfig.apiKey)
          decryptedKeyRef.current[ws.id] = { encrypted: ws.linearConfig.apiKey, plaintext }
        } catch {
          continue
        }
      }
      if (cancelled) return

      // Resolve identifiers per tree.
      const treeIdentifiers: { idx: number; identifier: string }[] = []
      ws.trees.forEach((_tree, idx) => {
        const branch = branches[idx]
        if (!branch) return
        const id = extractLinearIdentifier(branch)
        if (id) treeIdentifiers.push({ idx, identifier: id })
      })

      const uniqueIds = Array.from(new Set(treeIdentifiers.map((t) => t.identifier)))
      const now = Date.now()

      // Fetch missing/stale identifiers.
      await Promise.all(
        uniqueIds.map(async (id) => {
          const cached = issueCacheRef.current[id]
          if (cached && now - cached.fetchedAt < ISSUE_TTL_MS) return
          const issue = await fetchIssueByIdentifier(plaintext, id)
          issueCacheRef.current[id] = { issue, fetchedAt: Date.now() }
        }),
      )
      if (cancelled) return

      // Update state for every tree using cached results.
      setTreeLinearIssues((prev) => {
        const wsIssues: Record<number, LinearIssueSummary> = {}
        for (const { idx, identifier } of treeIdentifiers) {
          const cached = issueCacheRef.current[identifier]
          if (cached?.issue) wsIssues[idx] = cached.issue
        }
        // Avoid unnecessary re-render if shallow-equal to previous.
        const prevWs = prev[ws.id] ?? {}
        const sameKeys = Object.keys(prevWs).length === Object.keys(wsIssues).length
          && Object.keys(wsIssues).every((k) => prevWs[Number(k)] === wsIssues[Number(k)])
        if (sameKeys) return prev
        return { ...prev, [ws.id]: wsIssues }
      })
    }
  }

  const initialDelay = setTimeout(fetchLinearIssues, 5_000)
  const interval = setInterval(fetchLinearIssues, 60_000)
  return () => {
    cancelled = true
    clearTimeout(initialDelay)
    clearInterval(interval)
  }
}, [
  sortedWorkspaces.map((w) => w.id + w.trees.length).join(','),
  sortedWorkspaces.map((w) => `${w.id}:${w.linearConfig?.apiKey ?? ''}`).join(','),
])
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Lint**

Run: `bun run lint`
Expected: PASS (or only pre-existing warnings unrelated to this change).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/Sidebar.tsx
git commit -m "feat(desktop): poll Linear issues per worktree branch"
```

---

### Task 6: Render the Linear icon in the worktree row

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx` (around line 1471)

- [ ] **Step 1: Resolve `linearIssue` alongside `pr` in the tree-row scope**

Find the line that resolves `pr` for a tree row. Search for `const pr = treePRs[ws.id]?.[treeIdx]` (or similar pattern in the tree row map function). Immediately after that line, add:

```tsx
const linearIssue = treeLinearIssues[ws.id]?.[treeIdx]
```

If you cannot find an exact `const pr = ...` line, search for `treePRs[ws.id]?.[` to find where `pr` is dereferenced for rendering, and add `linearIssue` retrieval at the same scope.

- [ ] **Step 2: Insert the Linear icon JSX immediately after the PR icon block**

Find the existing PR-icon block at `Sidebar.tsx:1458-1471`:

```tsx
{pr && !isDeleting && (
  <Tooltip text={pr.title || `PR #${pr.number}`} side="right" bgColor={wsColor} textColor={txtColor} maxWidth={280}>
    <span
      className="shrink-0 flex items-center gap-0.5 opacity-70 hover:!opacity-100 cursor-pointer"
      style={{ color: txtColor }}
      onClick={(e) => { e.stopPropagation(); window.open(pr.url, '_blank', 'noopener,noreferrer') }}
    >
      <PRIcon state={pr.state} color={txtColor} size={12} />
      <span style={{ fontSize: '10px' }}>
        #{pr.number}
      </span>
    </span>
  </Tooltip>
)}
```

Immediately after the closing `)}` of that block, add:

```tsx
{linearIssue && !isDeleting && (
  <Tooltip
    text={`${linearIssue.identifier} · ${linearIssue.title} · ${linearIssue.state.name}`}
    side="right"
    bgColor={wsColor}
    textColor={txtColor}
    maxWidth={320}
  >
    <span
      className="shrink-0 flex items-center opacity-70 hover:!opacity-100 cursor-pointer"
      onClick={(e) => {
        e.stopPropagation()
        window.open(linearIssue.url, '_blank', 'noopener,noreferrer')
      }}
    >
      <LinearIssueIcon state={linearIssue.state} color={txtColor} size={12} />
    </span>
  </Tooltip>
)}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/Sidebar.tsx
git commit -m "feat(desktop): render Linear issue icon in worktree row"
```

---

### Task 7: Manual verification in dev mode

**No file changes** — this task only verifies behavior.

- [ ] **Step 1: Start the dev server**

Run: `bun run dev` (from repo root)
Expected: Electron window opens.

- [ ] **Step 2: Verify icon appears for a Linear-matched worktree**

Prerequisites: a workspace with `linearConfig` set (Settings → Linear → connect API key + select team) and a worktree whose branch contains a real Linear identifier (e.g. `eng-4504`).

- [ ] Wait up to 60s after the app starts.
- [ ] Confirm the Linear icon appears to the right of the PR icon (or alone in the same slot if no PR exists).
- [ ] Hover the icon — tooltip shows `IDENTIFIER · title · state name`.
- [ ] Click the icon — Linear opens in the default browser to the issue URL.
- [ ] Confirm the state-color dot in the bottom-right of the icon matches the issue's current workflow state color.

- [ ] **Step 3: Verify silent skip when no identifier matches**

- [ ] Switch to a worktree on `main` (or any branch with no Linear ID).
- [ ] Confirm no Linear icon renders.

- [ ] **Step 4: Verify silent skip when workspace has no Linear config**

- [ ] Open a workspace where `linearConfig` is not set.
- [ ] Confirm no Linear icon renders for any worktree, even if branch names contain identifiers.

- [ ] **Step 5: Verify slug-style branch matching**

- [ ] Use a worktree on a slug branch like `tedy/eng-4504-add-linear-icon`.
- [ ] Confirm the Linear icon appears.

- [ ] **Step 6: Verify failure mode (invalid API key)**

- [ ] Settings → Linear → save a deliberately wrong API key.
- [ ] Wait up to 60s.
- [ ] Confirm no Linear icon appears, no error UI surfaces (silent failure).
- [ ] Restore the correct key when done.

If any step fails, debug via the renderer console (View → Toggle Developer Tools → Console).

---

## Self-Review

**Spec coverage:**

- "Linear icon next to PR icon" → Task 6 (insert after PR block)
- "Match identifier in branch name with bounded regex" → Task 2
- "Tooltip with title + status" → Task 6 (Tooltip text format)
- "Click opens Linear external" → Task 6 (window.open)
- "State-colored dot on icon" → Task 4 (LinearIssueIcon)
- "60s polling, 5min TTL cache, dedupe by identifier" → Task 5
- "Silent failure (no error UI)" → Task 3 (try/catch returning null), Task 5 (decrypt try/catch)
- "Skip workspaces without linearConfig" → Task 5 (early continue + state-clearing)
- "API key per workspace, decrypted via safeStorage" → Task 5 (linearDecryptKey + decryptedKeyRef)
- "Manual test plan" → Task 7

All spec sections covered.

**Placeholder scan:** No "TBD"/"TODO"/"add appropriate"/"similar to". All code blocks present.

**Type consistency:**
- `LinearIssueSummary` defined Task 1, used Task 3 (return type), Task 4 (component prop), Task 5 (state).
- `extractLinearIdentifier` defined Task 2, used Task 5.
- `fetchIssueByIdentifier` defined Task 3, used Task 5.
- `LinearIssueIcon` defined Task 4, used Task 6.

All forward references resolve correctly.
