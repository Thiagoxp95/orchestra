# Linear Ticket Icon in Sidebar Worktree Row

**Status:** Draft
**Date:** 2026-04-30

## Goal

Add a Linear icon next to the existing PR icon in the sidebar worktree row. When the
worktree's branch contains a Linear-style ticket identifier (e.g. `ENG-4504`) and the
workspace has Linear connected, fetch the matching issue and render an icon that:

- shows the issue's workflow state at a glance (state-colored dot on the icon),
- on hover, surfaces the identifier, title, and state name,
- on click, opens the issue in Linear (external).

This mirrors the existing PR-icon affordance at `Sidebar.tsx:1458-1471` so both signals
sit in the same row, in the same visual style.

## Non-Goals

- Editing the ticket from the sidebar. The existing `IssueDetailPanel` already covers
  in-app editing.
- Per-workspace toggle for the icon. Visibility is implicit — present iff there's a
  match and Linear is configured.
- Clicking the icon to open `IssueDetailPanel` instead of external Linear. The user
  asked for external; we keep it consistent with the PR icon's behavior.
- Auto-creating worktrees from Linear issues, or moving the issue when the branch
  state changes. (`IssueBoard` and existing automations cover this elsewhere.)

## User-Visible Behavior

For a worktree row with branch `eng-4504` (or `tedy/eng-4504-add-x`, or
`feat/eng-4504-thing`) in a workspace where `linearConfig` is set:

```
[folder-or-branch icon]  <branch name>   [PR icon] #3051   [Linear icon · state-dot]
```

- The Linear icon renders to the **right** of the PR icon. If there is no PR, it still
  renders in the same slot.
- The icon is the Linear logo (12px), with a 6px state-colored dot positioned at its
  bottom-right (using the issue's `state.color`).
- Tooltip text: `ENG-4504 · {title} · {state.name}` (e.g., `ENG-4504 · Add Linear icon
  to sidebar · In Progress`).
- Click opens `issue.url` in the user's default browser (`window.open(url, '_blank',
  'noopener,noreferrer')`), with `e.stopPropagation()` so the row's own click handler
  doesn't fire.

If any of the following are true, the icon is silently omitted (no error UI):

- Workspace has no `linearConfig`.
- The branch contains no `[a-z]+-\d+` token at a valid boundary.
- The Linear API call fails (network error, 401, issue not found, etc.).

## Identifier Extraction

A pure helper in a new file `apps/desktop/src/renderer/src/utils/linear-branch.ts`:

```ts
const PATTERN = /(?:^|[\/\-])([a-zA-Z]{2,5})-(\d+)(?=$|[\/\-])/

export function extractLinearIdentifier(branch: string): string | null {
  const m = PATTERN.exec(branch)
  if (!m) return null
  return `${m[1].toUpperCase()}-${m[2]}`
}
```

Bounded matching rules (covers approach C from brainstorming):

- The prefix-number pair must be flanked by start-of-string, `/`, or `-` on the left,
  and end-of-string, `/`, or `-` on the right. This means `tedy/eng-4504-add-x`,
  `feat/eng-4504`, `eng-4504`, and `eng-4504-foo` all match. `notes/q-2-recap` does
  not match — `q` is one letter and the regex requires a 2-letter minimum prefix.

Prefix length: 2-5 letters. Matches Linear's documented team-key length (1-5),
excluding single-letter prefixes to avoid false positives like `q-2`. Crucially this
also excludes longer English words that would otherwise leak through (e.g.
`release-2026` → `release` is 7 letters, no match).

**First-match-wins.** If a branch contains multiple matches (rare:
`tedy/eng-4504-fixes-dev-99`), we use the first.

The helper has a colocated unit test
(`apps/desktop/src/renderer/src/utils/linear-branch.test.ts`) covering:

- Whole-branch match (`eng-4504` → `ENG-4504`).
- Linear-style slug (`tedy/eng-4504-add-linear-icon` → `ENG-4504`).
- Casing normalization (`ENG-4504`, `Eng-4504`, `eng-4504` all → `ENG-4504`).
- No match (`main`, `feature/no-id`, `release-2026`).
- No mid-token false positive (`releaseV2-2026` should not extract; bounded by start
  but the `V2-2026` wouldn't pass the prefix length floor of 2 letters — `V2` is
  letters+digit, doesn't match `[a-zA-Z]{2,8}`).
- Multi-match returns the first.

## API Layer

Extend `apps/desktop/src/renderer/src/utils/linear-client.ts`:

```ts
export async function fetchIssueByIdentifier(
  apiKey: string,
  identifier: string,
): Promise<LinearIssueSummary | null>
```

Implementation: GraphQL `query($id: String!) { issue(id: $id) { ... } }`. Linear's
`issue(id)` endpoint accepts both UUIDs and human identifiers like `ENG-4504`.

Returns:

- `LinearIssueSummary` on success.
- `null` if the issue lookup throws (catch all errors at the boundary — caller should
  not have to think about error states).

The `linearQuery` helper already throws on 401/403/429/non-OK. We wrap the call in a
try/catch in `fetchIssueByIdentifier` and return `null`, matching `getGitPRInfo`'s
silent-failure contract.

### Type addition (`apps/desktop/src/shared/linear-types.ts`)

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

## Polling and Caching

A new `useEffect` in `Sidebar.tsx`, modeled on the PR polling block at
`Sidebar.tsx:716-746`:

**Cadence:** 60s (PR uses 30s; Linear state changes less often than PR review state,
and we want to be polite with the API).

**Decryption:** The workspace's `linearConfig.apiKey` is encrypted via safeStorage.
Decryption goes through `window.electronAPI.linearDecryptKey`. Caching:

- A `useRef` `decryptedKeyRef` keyed by `(wsId, encryptedApiKey)` → decrypted plaintext.
- Decrypt on first use; reuse the cached plaintext until the encrypted key changes
  (key rotation invalidates).

**Issue cache:** A `useRef` `issueCacheRef`: `Record<identifier, { issue:
LinearIssueSummary | null, fetchedAt: number }>`. TTL 5 minutes. Multiple worktrees
sharing the same identifier hit the cache rather than refetching.

**Workspace gating:** The polling effect skips workspaces without `linearConfig`.

**Per-tick flow:**

1. For each workspace with `linearConfig`:
   1. Decrypt key (cached).
   2. Collect unique identifiers across the workspace's trees (extract from each
      tree's branch via `extractLinearIdentifier`).
   3. For each unique identifier: if cache has a fresh entry (within TTL), reuse;
      otherwise call `fetchIssueByIdentifier`. Update cache on response.
   4. Update `treeLinearIssues[wsId][treeIdx]` for every tree using its extracted
      identifier (or remove the entry if extraction returned null or fetch returned
      null).

**Initial delay:** First fetch fires after a 5s delay (matches the PR effect's
`initialDelay = 5_000`), letting branch polling populate first.

**Effect dependency array:** Mirror the PR effect's
`sortedWorkspaces.map((w) => w.id + w.trees.length).join(',')` and append a
linear-config signature so adding/removing/rotating Linear config retriggers the
effect:

```ts
const linearSig = sortedWorkspaces
  .map((w) => `${w.id}:${w.linearConfig?.apiKey ?? ''}`)
  .join(',')
useEffect(() => { /* ... */ }, [
  sortedWorkspaces.map((w) => w.id + w.trees.length).join(','),
  linearSig,
])
```

When a workspace's `linearConfig` is removed, the per-tick flow's "skip workspaces
without `linearConfig`" rule clears its entries from `treeLinearIssues` (we explicitly
delete the workspace's key on the next tick).

## State Shape (`Sidebar.tsx`)

```ts
const [treeLinearIssues, setTreeLinearIssues] =
  useState<Record<string, Record<number, LinearIssueSummary>>>({})
```

Same nested-record shape as `treePRs` for consistency.

## Rendering

A new `LinearIssueIcon` component near the existing `PRIcon` definition at
`Sidebar.tsx:62`:

```tsx
function LinearIssueIcon({
  state,
  color,
  size = 12,
}: { state: LinearIssueSummary['state']; color: string; size?: number }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {/* Linear logo SVG, fill={color} */}
      <svg width={size} height={size} viewBox="0 0 100 100" fill={color}>
        {/* Linear logo path */}
      </svg>
      <span
        className="absolute -bottom-0.5 -right-0.5 rounded-full"
        style={{
          width: size / 2,
          height: size / 2,
          backgroundColor: state.color,
          boxShadow: `0 0 0 1px ${color}`, // ring matches the icon stroke color so the dot reads on busy bg
        }}
      />
    </span>
  )
}
```

The icon stroke color follows the existing `txtColor` pattern. The dot uses the
issue's workflow state color directly.

In the tree row JSX (after the existing `pr` block at ~line 1471):

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

`linearIssue` resolves from `treeLinearIssues[ws.id]?.[treeIdx]`.

## Edge Cases

- **Branch rename mid-session.** Next 60s tick re-extracts; old entry cleared if no
  match.
- **Workspace's linearConfig removed.** Polling effect's dependency array re-runs;
  state cleared for that workspace.
- **API key rotated.** `decryptedKeyRef` invalidates because the encrypted key changes.
- **Worktree with branch `eng-4504` but in a workspace whose `teamId` is different.**
  Still resolves: the API key is org-wide. We don't filter by `teamId`.
- **Two workspaces with different Linear keys, same identifier.** Each workspace
  fetches independently; the cache key is identifier-only, so the second workspace
  reads the first workspace's cached result. Acceptable: identifier→issue is
  globally unique within a Linear org. (If the user has two unrelated Linear orgs in
  two workspaces, the cache would be wrong. We accept this trade-off — the
  user-confused-org case is rare and the worst outcome is a stale icon for 5
  minutes.)
- **Linear API down for an extended period.** Cache returns stale entries until TTL
  elapses, then attempts to refetch on the next tick. No retry storm.
- **`gh` PR slot is empty.** Linear icon still renders in the same place; layout flows
  naturally because both icons are inline-flex children.

## Files Touched

| Path | Change |
|---|---|
| `apps/desktop/src/shared/linear-types.ts` | Add `LinearIssueSummary` |
| `apps/desktop/src/renderer/src/utils/linear-client.ts` | Add `fetchIssueByIdentifier` |
| `apps/desktop/src/renderer/src/utils/linear-branch.ts` | New: identifier extraction |
| `apps/desktop/src/renderer/src/utils/linear-branch.test.ts` | New: unit tests |
| `apps/desktop/src/renderer/src/components/Sidebar.tsx` | `LinearIssueIcon`, polling effect, render |

## Testing Plan

- Unit test for `extractLinearIdentifier` (cases above).
- Manual: connect Linear in a workspace, create a worktree with branch `eng-X` (real
  ticket), verify icon renders, hover tooltip, click opens Linear.
- Manual: same with a slug branch (`tedy/eng-X-feature`).
- Manual: branch with no Linear ID (`main`) → no icon.
- Manual: workspace without Linear config → no icon for any tree.
- Manual: rename branch mid-session → icon updates within 60s.
- Manual: invalid API key → no icon, no error UI.

## Open Questions

None — this is implementation-ready.
