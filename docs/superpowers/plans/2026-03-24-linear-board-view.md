# Linear Board View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a kanban board view per workspace that integrates with Linear's API to display and manage team tickets.

**Architecture:** Renderer-only Linear GraphQL client (no SDK). API keys encrypted via Electron `safeStorage` with two IPC channels. Board replaces `TerminalArea` in main content when active. Drag-and-drop for status changes via native HTML5 DnD.

**Tech Stack:** React 19, TypeScript, zustand, Electron safeStorage, Linear GraphQL API, native HTML5 drag-and-drop

**Spec:** `docs/superpowers/specs/2026-03-24-linear-board-view-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/shared/linear-types.ts` | Linear API response types (Team, Issue, WorkflowState, etc.) |
| `src/main/linear-safe-storage.ts` | safeStorage encrypt/decrypt + IPC handler registration |
| `src/renderer/src/utils/linear-client.ts` | GraphQL fetch wrapper for Linear API |
| `src/renderer/src/hooks/useLinearBoard.ts` | React hook: fetch, poll, cache board data |
| `src/renderer/src/components/LinearBoard.tsx` | Kanban board with columns + drag-and-drop |
| `src/renderer/src/components/LinearTicketCard.tsx` | Individual ticket card component |
| `src/renderer/src/components/LinearDetailPanel.tsx` | Slide-in ticket detail panel |

### Modified files

| File | Changes |
|------|---------|
| `src/shared/types.ts` | Add `viewMode?`, `linearConfig?` to `Workspace`; add `linearEncryptKey`, `linearDecryptKey` to `ElectronAPI` |
| `src/main/index.ts` | Import and call `registerLinearSafeStorage(ipcMain)` |
| `src/preload/index.ts` | Bridge `linear:encrypt-key` and `linear:decrypt-key` IPC |
| `src/renderer/src/store/app-store.ts` | Extend `updateWorkspace` Pick type; add `linearBoardCache` state + actions; clean cache on `deleteWorkspace` |
| `src/renderer/src/components/Sidebar.tsx` | Add view mode toggle icons above workspace content; hide trees/sessions in board mode; show board summary |
| `src/renderer/src/components/SettingsDialog.tsx` | Add "Linear" settings page with API key input, team selector, disconnect button |
| `src/renderer/src/App.tsx` | Conditionally render `LinearBoard` vs `TerminalArea` based on active workspace `viewMode` |

---

## Task 1: Shared Types — Workspace Extensions & Linear Types

**Files:**
- Modify: `apps/desktop/src/shared/types.ts`
- Create: `apps/desktop/src/shared/linear-types.ts`

- [ ] **Step 1: Add `viewMode` and `linearConfig` to Workspace type**

In `apps/desktop/src/shared/types.ts`, add to the `Workspace` interface after `questionNotificationSound`:

```ts
  viewMode?: 'orchestrator' | 'board'
  linearConfig?: {
    apiKey: string   // encrypted via safeStorage, stored as base64
    teamId: string
    teamName: string
  }
```

- [ ] **Step 2: Add Linear IPC methods to ElectronAPI**

In `apps/desktop/src/shared/types.ts`, add to the `ElectronAPI` interface (after the Usage tracking section):

```ts
  // Linear safe storage
  linearEncryptKey: (rawKey: string) => Promise<string>
  linearDecryptKey: (encryptedKey: string) => Promise<string>
```

- [ ] **Step 3: Create Linear API types**

Create `apps/desktop/src/shared/linear-types.ts`:

```ts
export interface LinearTeam {
  id: string
  name: string
  key: string
}

export interface LinearWorkflowState {
  id: string
  name: string
  color: string
  position: number
  type: string // 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'
}

export interface LinearUser {
  id: string
  name: string
  displayName: string
  avatarUrl: string | null
}

export interface LinearLabel {
  id: string
  name: string
  color: string
}

export interface LinearIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  priority: number // 0=none, 1=urgent, 2=high, 3=medium, 4=low
  priorityLabel: string
  url: string
  state: LinearWorkflowState
  assignee: LinearUser | null
  labels: { nodes: LinearLabel[] }
  createdAt: string
  updatedAt: string
}

export interface LinearBoardData {
  columns: LinearWorkflowState[]
  issues: LinearIssue[]
  teamName: string
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/shared/types.ts apps/desktop/src/shared/linear-types.ts
git commit -m "feat(linear): add workspace viewMode, linearConfig types and Linear API types"
```

---

## Task 2: SafeStorage IPC — Main Process + Preload

**Files:**
- Create: `apps/desktop/src/main/linear-safe-storage.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`

- [ ] **Step 1: Create safeStorage module**

Create `apps/desktop/src/main/linear-safe-storage.ts`:

```ts
import { safeStorage, type IpcMain } from 'electron'

export function registerLinearSafeStorage(ipc: IpcMain): void {
  ipc.handle('linear:encrypt-key', (_event, rawKey: string): string => {
    if (!safeStorage.isEncryptionAvailable()) {
      // Fallback: base64 encode (not secure, but works on systems without keychain)
      return Buffer.from(rawKey, 'utf-8').toString('base64')
    }
    return safeStorage.encryptString(rawKey).toString('base64')
  })

  ipc.handle('linear:decrypt-key', (_event, encryptedKey: string): string => {
    if (!safeStorage.isEncryptionAvailable()) {
      return Buffer.from(encryptedKey, 'base64').toString('utf-8')
    }
    return safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'))
  })
}
```

- [ ] **Step 2: Register in main process**

In `apps/desktop/src/main/index.ts`, add import at top:

```ts
import { registerLinearSafeStorage } from './linear-safe-storage'
```

Then after the existing `ipcMain.handle` block (after all the other IPC registrations), add:

```ts
registerLinearSafeStorage(ipcMain)
```

- [ ] **Step 3: Bridge in preload**

In `apps/desktop/src/preload/index.ts`, add to the `api` object:

```ts
  // Linear safe storage
  linearEncryptKey: (rawKey: string): Promise<string> => {
    return ipcRenderer.invoke('linear:encrypt-key', rawKey)
  },
  linearDecryptKey: (encryptedKey: string): Promise<string> => {
    return ipcRenderer.invoke('linear:decrypt-key', encryptedKey)
  },
```

- [ ] **Step 4: Verify build**

Run: `cd apps/desktop && bun run build`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/linear-safe-storage.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts
git commit -m "feat(linear): add safeStorage IPC for API key encryption"
```

---

## Task 3: Linear GraphQL Client

**Files:**
- Create: `apps/desktop/src/renderer/src/utils/linear-client.ts`

- [ ] **Step 1: Create the client**

Create `apps/desktop/src/renderer/src/utils/linear-client.ts`:

```ts
import type { LinearTeam, LinearWorkflowState, LinearIssue, LinearBoardData } from '../../../../shared/linear-types'

const LINEAR_API = 'https://api.linear.app/graphql'

async function linearQuery<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (res.status === 401) throw new Error('LINEAR_UNAUTHORIZED')
  if (res.status === 403) throw new Error('LINEAR_FORBIDDEN')
  if (res.status === 429) throw new Error('LINEAR_RATE_LIMITED')
  if (!res.ok) throw new Error(`LINEAR_API_ERROR:${res.status}`)

  const json = await res.json()
  if (json.errors?.length) throw new Error(`LINEAR_GRAPHQL_ERROR:${json.errors[0].message}`)
  return json.data
}

export async function fetchTeams(apiKey: string): Promise<LinearTeam[]> {
  const data = await linearQuery<{ teams: { nodes: LinearTeam[] } }>(apiKey, `
    query { teams { nodes { id name key } } }
  `)
  return data.teams.nodes
}

export async function fetchBoardData(apiKey: string, teamId: string): Promise<LinearBoardData> {
  const data = await linearQuery<{
    team: {
      name: string
      states: { nodes: LinearWorkflowState[] }
      issues: { nodes: LinearIssue[] }
    }
  }>(apiKey, `
    query($teamId: String!) {
      team(id: $teamId) {
        name
        states: workflowStates {
          nodes { id name color position type }
        }
        issues(first: 200, orderBy: updatedAt, filter: { state: { type: { nin: ["cancelled"] } } }) {
          nodes {
            id identifier title description priority priorityLabel url
            state { id name color position type }
            assignee { id name displayName avatarUrl }
            labels { nodes { id name color } }
            createdAt updatedAt
          }
        }
      }
    }
  `, { teamId })

  return {
    columns: data.team.states.nodes.sort((a, b) => a.position - b.position),
    issues: data.team.issues.nodes,
    teamName: data.team.name,
  }
}

export async function updateIssueState(apiKey: string, issueId: string, stateId: string): Promise<void> {
  await linearQuery(apiKey, `
    mutation($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) {
        success
      }
    }
  `, { issueId, stateId })
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/utils/linear-client.ts
git commit -m "feat(linear): add GraphQL client for Linear API"
```

---

## Task 4: Store Extensions — Board Cache & Workspace Updates

**Files:**
- Modify: `apps/desktop/src/renderer/src/store/app-store.ts`

- [ ] **Step 1: Extend updateWorkspace type**

In `apps/desktop/src/renderer/src/store/app-store.ts`, find the `updateWorkspace` type signature (around line 282-285):

```ts
  updateWorkspace: (
    id: string,
    updates: Partial<Pick<Workspace, 'name' | 'color' | 'notificationSound' | 'questionNotificationSound' | 'repositorySettings'>>
  ) => void
```

Change to:

```ts
  updateWorkspace: (
    id: string,
    updates: Partial<Pick<Workspace, 'name' | 'color' | 'notificationSound' | 'questionNotificationSound' | 'repositorySettings' | 'viewMode' | 'linearConfig'>>
  ) => void
```

- [ ] **Step 2: Add board cache state and actions to the store interface**

Find the store interface/type definition. Add these fields:

```ts
  linearBoardCache: Record<string, import('../../../../shared/linear-types').LinearBoardData>
  linearMutationInflight: Record<string, boolean>  // keyed by workspaceId
  setLinearBoardCache: (workspaceId: string, data: import('../../../../shared/linear-types').LinearBoardData) => void
  clearLinearBoardCache: (workspaceId: string) => void
  setLinearMutationInflight: (workspaceId: string, inflight: boolean) => void
```

Add to the store's initial state:

```ts
  linearBoardCache: {},
  linearMutationInflight: {},
```

Add the action implementations:

```ts
  setLinearBoardCache: (workspaceId, data) => {
    set((state) => {
      // Don't overwrite cache during an in-flight mutation (preserves optimistic state)
      if (state.linearMutationInflight[workspaceId]) return state
      return { linearBoardCache: { ...state.linearBoardCache, [workspaceId]: data } }
    })
  },

  clearLinearBoardCache: (workspaceId) => {
    set((state) => {
      const next = { ...state.linearBoardCache }
      delete next[workspaceId]
      return { linearBoardCache: next }
    })
  },

  setLinearMutationInflight: (workspaceId, inflight) => {
    set((state) => ({
      linearMutationInflight: { ...state.linearMutationInflight, [workspaceId]: inflight }
    }))
  },
```

- [ ] **Step 3: Clean board cache on workspace deletion**

In the `deleteWorkspace` action (around line 450), add before `return`:

```ts
      const newLinearBoardCache = { ...state.linearBoardCache }
      delete newLinearBoardCache[id]
```

And add `linearBoardCache: newLinearBoardCache` to the returned object.

- [ ] **Step 4: Verify build**

Run: `cd apps/desktop && bun run build`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/store/app-store.ts
git commit -m "feat(linear): extend store with viewMode, linearConfig, and board cache"
```

---

## Task 5: useLinearBoard Hook

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/useLinearBoard.ts`

- [ ] **Step 1: Create the hook**

Create `apps/desktop/src/renderer/src/hooks/useLinearBoard.ts`:

```ts
import { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../store/app-store'
import { fetchBoardData } from '../utils/linear-client'
import type { LinearBoardData } from '../../../../shared/linear-types'

const POLL_INTERVAL = 45_000
const MAX_POLL_INTERVAL = 300_000
const MANUAL_REFRESH_THROTTLE = 10_000

interface UseLinearBoardResult {
  data: LinearBoardData | null
  loading: boolean
  error: string | null
  errorType: 'auth' | 'team' | 'network' | null
  refresh: () => void
  lastRefreshed: number | null
  decryptedKey: string | null  // exposed for mutation use by LinearBoard
}

export function useLinearBoard(
  workspaceId: string | null,
  linearConfig: { apiKey: string; teamId: string; teamName: string } | undefined,
  active: boolean,
): UseLinearBoardResult {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorType, setErrorType] = useState<'auth' | 'team' | 'network' | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null)
  const [decryptedKey, setDecryptedKey] = useState<string | null>(null)
  const pollIntervalRef = useRef(POLL_INTERVAL)
  const lastManualRefreshRef = useRef(0)
  const inflight = useRef(false)
  const cancelledRef = useRef(false)

  const cached = useAppStore((s) => workspaceId ? s.linearBoardCache[workspaceId] ?? null : null)
  const setCache = useAppStore((s) => s.setLinearBoardCache)

  // Decrypt key once
  useEffect(() => {
    if (!linearConfig?.apiKey) {
      setDecryptedKey(null)
      return
    }
    window.electronAPI.linearDecryptKey(linearConfig.apiKey).then(setDecryptedKey)
  }, [linearConfig?.apiKey])

  const doFetch = useCallback(async () => {
    if (!workspaceId || !linearConfig?.teamId || !decryptedKey || inflight.current) return

    inflight.current = true
    setLoading(!cached)
    setError(null)
    setErrorType(null)

    try {
      const data = await fetchBoardData(decryptedKey, linearConfig.teamId)
      if (!cancelledRef.current) {
        setCache(workspaceId, data)
        setLastRefreshed(Date.now())
        pollIntervalRef.current = POLL_INTERVAL
      }
    } catch (err: any) {
      if (cancelledRef.current) return
      const msg = err?.message ?? 'Unknown error'
      if (msg === 'LINEAR_UNAUTHORIZED') {
        setError('Linear API key is invalid or expired')
        setErrorType('auth')
      } else if (msg === 'LINEAR_RATE_LIMITED') {
        setError('Rate limited — retrying soon')
        setErrorType('network')
        pollIntervalRef.current = Math.min(pollIntervalRef.current * 2, MAX_POLL_INTERVAL)
      } else if (msg.startsWith('LINEAR_GRAPHQL_ERROR:')) {
        const detail = msg.replace('LINEAR_GRAPHQL_ERROR:', '')
        if (detail.includes('not found') || detail.includes('does not exist')) {
          setError('Team not found — it may have been deleted in Linear')
          setErrorType('team')
        } else {
          setError(detail)
          setErrorType('network')
        }
      } else {
        setError(cached ? null : 'Failed to connect to Linear')
        setErrorType(cached ? null : 'network')
      }
    } finally {
      inflight.current = false
      setLoading(false)
    }
  }, [workspaceId, linearConfig?.teamId, decryptedKey, cached, setCache])

  // Poll using recursive setTimeout (respects dynamic interval from rate limiting)
  useEffect(() => {
    if (!active || !linearConfig?.teamId || !decryptedKey) return
    cancelledRef.current = false

    // Initial fetch
    doFetch()

    let timeoutId: ReturnType<typeof setTimeout>
    const schedulePoll = () => {
      timeoutId = setTimeout(() => {
        if (!cancelledRef.current && document.visibilityState === 'visible') {
          doFetch().then(schedulePoll)
        } else {
          schedulePoll() // reschedule even if skipped
        }
      }, pollIntervalRef.current)
    }
    schedulePoll()

    // Refetch on visibility change
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') doFetch()
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      cancelledRef.current = true
      clearTimeout(timeoutId)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [active, linearConfig?.teamId, decryptedKey, doFetch])

  const refresh = useCallback(() => {
    const now = Date.now()
    if (now - lastManualRefreshRef.current < MANUAL_REFRESH_THROTTLE) return
    lastManualRefreshRef.current = now
    doFetch()
  }, [doFetch])

  return { data: cached, loading, error, errorType, refresh, lastRefreshed, decryptedKey }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/useLinearBoard.ts
git commit -m "feat(linear): add useLinearBoard hook with polling and caching"
```

---

## Task 6: LinearTicketCard Component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/LinearTicketCard.tsx`

- [ ] **Step 1: Create the ticket card**

Create `apps/desktop/src/renderer/src/components/LinearTicketCard.tsx`:

```tsx
import type { LinearIssue } from '../../../../shared/linear-types'

const PRIORITY_COLORS: Record<number, string> = {
  0: '#8b8b8b', // none
  1: '#f76a6a', // urgent
  2: '#f59e0b', // high
  3: '#3b82f6', // medium
  4: '#6b7280', // low
}

interface LinearTicketCardProps {
  issue: LinearIssue
  txtColor: string
  isLight: boolean
  onClick: () => void
  onDragStart: (e: React.DragEvent) => void
}

export function LinearTicketCard({ issue, txtColor, isLight, onClick, onDragStart }: LinearTicketCardProps) {
  const bg = isLight ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.06)'
  const hoverBg = isLight ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.1)'
  const labels = issue.labels.nodes.slice(0, 2)
  const overflowCount = issue.labels.nodes.length - 2

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      className="rounded-lg px-3 py-2.5 cursor-pointer transition-colors group"
      style={{ backgroundColor: bg, color: txtColor }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = hoverBg }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = bg }}
    >
      {/* Identifier + Priority */}
      <div className="flex items-center gap-1.5 mb-1">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: PRIORITY_COLORS[issue.priority] ?? PRIORITY_COLORS[0] }}
          title={issue.priorityLabel}
        />
        <span className="text-[10px] font-mono opacity-50">{issue.identifier}</span>
      </div>

      {/* Title */}
      <div className="text-sm leading-5 line-clamp-2">{issue.title}</div>

      {/* Footer: labels + assignee */}
      <div className="flex items-center justify-between mt-2 gap-2">
        <div className="flex items-center gap-1 min-w-0 overflow-hidden">
          {labels.map((label) => (
            <span
              key={label.id}
              className="text-[10px] px-1.5 py-0.5 rounded-full truncate max-w-[80px]"
              style={{
                backgroundColor: `${label.color}22`,
                color: label.color,
                border: `1px solid ${label.color}44`,
              }}
            >
              {label.name}
            </span>
          ))}
          {overflowCount > 0 && (
            <span className="text-[10px] opacity-40">+{overflowCount}</span>
          )}
        </div>

        {issue.assignee && (
          <div
            className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-[9px] font-bold"
            style={{
              backgroundColor: isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)',
            }}
            title={issue.assignee.displayName}
          >
            {issue.assignee.avatarUrl ? (
              <img
                src={issue.assignee.avatarUrl}
                alt=""
                className="w-full h-full rounded-full object-cover"
              />
            ) : (
              issue.assignee.displayName.charAt(0).toUpperCase()
            )}
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/LinearTicketCard.tsx
git commit -m "feat(linear): add LinearTicketCard component"
```

---

## Task 7: LinearDetailPanel Component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/LinearDetailPanel.tsx`

- [ ] **Step 1: Create the detail panel**

Create `apps/desktop/src/renderer/src/components/LinearDetailPanel.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import type { LinearIssue, LinearWorkflowState } from '../../../../shared/linear-types'
import { isLightColor } from '../utils/color'

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'No priority', color: '#8b8b8b' },
  1: { label: 'Urgent', color: '#f76a6a' },
  2: { label: 'High', color: '#f59e0b' },
  3: { label: 'Medium', color: '#3b82f6' },
  4: { label: 'Low', color: '#6b7280' },
}

interface LinearDetailPanelProps {
  issue: LinearIssue
  columns: LinearWorkflowState[]
  wsColor: string
  txtColor: string
  onClose: () => void
  onStatusChange: (issueId: string, stateId: string) => void
  onNavigate: (direction: 'up' | 'down') => void
}

export function LinearDetailPanel({
  issue,
  columns,
  wsColor,
  txtColor,
  onClose,
  onStatusChange,
  onNavigate,
}: LinearDetailPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const isLight = isLightColor(wsColor)
  const bg = isLight ? 'rgba(255,255,255,0.85)' : 'rgba(20,20,35,0.95)'
  const priority = PRIORITY_LABELS[issue.priority] ?? PRIORITY_LABELS[0]

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'ArrowUp') { e.preventDefault(); onNavigate('up') }
      if (e.key === 'ArrowDown') { e.preventDefault(); onNavigate('down') }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, onNavigate])

  return (
    <div
      ref={panelRef}
      className="w-[400px] shrink-0 border-l overflow-y-auto"
      style={{
        backgroundColor: bg,
        borderColor: `${txtColor}15`,
        color: txtColor,
      }}
    >
      {/* Header */}
      <div className="sticky top-0 flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: `${txtColor}10`, backgroundColor: bg }}>
        <span className="text-xs font-mono opacity-50">{issue.identifier}</span>
        <div className="flex items-center gap-2">
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs opacity-50 hover:opacity-100 transition-opacity"
            title="Open in Linear"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4" />
              <path d="M7 9l7-7" />
              <path d="M10 2h4v4" />
            </svg>
          </a>
          <button
            onClick={onClose}
            className="text-sm opacity-50 hover:opacity-100 transition-opacity"
          >
            x
          </button>
        </div>
      </div>

      {/* Title */}
      <div className="px-4 pt-4 pb-3">
        <h2 className="text-base font-semibold leading-6">{issue.title}</h2>
      </div>

      {/* Metadata */}
      <div className="px-4 pb-3 flex flex-wrap items-center gap-2">
        {/* Status dropdown */}
        <select
          value={issue.state.id}
          onChange={(e) => onStatusChange(issue.id, e.target.value)}
          className="text-xs px-2 py-1 rounded-md border appearance-none cursor-pointer"
          style={{
            backgroundColor: `${issue.state.color}22`,
            borderColor: `${issue.state.color}44`,
            color: txtColor,
          }}
        >
          {columns.map((col) => (
            <option key={col.id} value={col.id} style={{ backgroundColor: isLight ? '#fff' : '#1a1a2e', color: isLight ? '#000' : '#fff' }}>
              {col.name}
            </option>
          ))}
        </select>

        {/* Priority */}
        <span
          className="text-[10px] px-2 py-0.5 rounded-full"
          style={{ backgroundColor: `${priority.color}22`, color: priority.color }}
        >
          {priority.label}
        </span>

        {/* Assignee */}
        {issue.assignee && (
          <span className="text-xs opacity-70">{issue.assignee.displayName}</span>
        )}
      </div>

      {/* Labels */}
      {issue.labels.nodes.length > 0 && (
        <div className="px-4 pb-3 flex flex-wrap gap-1">
          {issue.labels.nodes.map((label) => (
            <span
              key={label.id}
              className="text-[10px] px-1.5 py-0.5 rounded-full"
              style={{
                backgroundColor: `${label.color}22`,
                color: label.color,
                border: `1px solid ${label.color}44`,
              }}
            >
              {label.name}
            </span>
          ))}
        </div>
      )}

      {/* Description */}
      <div className="px-4 pb-6 border-t pt-4" style={{ borderColor: `${txtColor}10` }}>
        {issue.description ? (
          <pre className="text-sm leading-6 whitespace-pre-wrap font-sans opacity-80">{issue.description}</pre>
        ) : (
          <p className="text-sm opacity-40 italic">No description</p>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/LinearDetailPanel.tsx
git commit -m "feat(linear): add LinearDetailPanel component"
```

---

## Task 8: LinearBoard Component (Kanban + Drag-and-Drop)

**Files:**
- Create: `apps/desktop/src/renderer/src/components/LinearBoard.tsx`

- [ ] **Step 1: Create the board component**

Create `apps/desktop/src/renderer/src/components/LinearBoard.tsx`:

```tsx
import { useState, useCallback, useRef } from 'react'
import { useLinearBoard } from '../hooks/useLinearBoard'
import { updateIssueState } from '../utils/linear-client'
import { useAppStore } from '../store/app-store'
import { LinearTicketCard } from './LinearTicketCard'
import { LinearDetailPanel } from './LinearDetailPanel'
import { isLightColor, textColor } from '../utils/color'
import type { LinearIssue, LinearWorkflowState } from '../../../../shared/linear-types'

interface LinearBoardProps {
  workspaceId: string
  linearConfig?: { apiKey: string; teamId: string; teamName: string }
  wsColor: string
  onOpenSettings: () => void
}

export function LinearBoard({ workspaceId, linearConfig, wsColor, onOpenSettings }: LinearBoardProps) {
  const { data, loading, error, errorType, refresh, lastRefreshed, decryptedKey } = useLinearBoard(workspaceId, linearConfig, true)
  const setCache = useAppStore((s) => s.setLinearBoardCache)
  const setMutationInflight = useAppStore((s) => s.setLinearMutationInflight)
  const txtColor = textColor(wsColor)
  const isLight = isLightColor(wsColor)

  const [selectedIssue, setSelectedIssue] = useState<LinearIssue | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'error' | 'info' } | null>(null)
  const dragIssueRef = useRef<LinearIssue | null>(null)

  const showToast = useCallback((message: string, type: 'error' | 'info' = 'error') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3000)
  }, [])

  const handleDragStart = useCallback((e: React.DragEvent, issue: LinearIssue) => {
    dragIssueRef.current = issue
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', issue.id)
    ;(e.currentTarget as HTMLElement).style.opacity = '0.5'
  }, [])

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    ;(e.currentTarget as HTMLElement).style.opacity = '1'
    setDragOverColumn(null)
    dragIssueRef.current = null
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, columnId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverColumn(columnId)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverColumn(null)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent, targetState: LinearWorkflowState) => {
    e.preventDefault()
    setDragOverColumn(null)
    const issue = dragIssueRef.current
    if (!issue || issue.state.id === targetState.id || !data || !decryptedKey) return

    // Optimistic update — set inflight flag to prevent poll overwrites
    setMutationInflight(workspaceId, true)
    const previousData = data
    const updatedIssues = data.issues.map((i) =>
      i.id === issue.id ? { ...i, state: targetState } : i
    )
    // Bypass the inflight guard by using the store's set directly
    useAppStore.setState((s) => ({
      linearBoardCache: { ...s.linearBoardCache, [workspaceId]: { ...data, issues: updatedIssues } }
    }))
    if (selectedIssue?.id === issue.id) {
      setSelectedIssue({ ...issue, state: targetState })
    }

    try {
      await updateIssueState(decryptedKey, issue.id, targetState.id)
    } catch (err: any) {
      // Revert
      useAppStore.setState((s) => ({
        linearBoardCache: { ...s.linearBoardCache, [workspaceId]: previousData }
      }))
      if (selectedIssue?.id === issue.id) setSelectedIssue(issue)
      if (err?.message === 'LINEAR_FORBIDDEN' || err?.message === 'LINEAR_UNAUTHORIZED') {
        showToast('No permission to update issues')
      } else {
        showToast('Failed to update status')
      }
    } finally {
      setMutationInflight(workspaceId, false)
    }
  }, [data, workspaceId, decryptedKey, selectedIssue, showToast, setMutationInflight])

  const handleStatusChange = useCallback(async (issueId: string, stateId: string) => {
    if (!data || !decryptedKey) return
    const targetState = data.columns.find((c) => c.id === stateId)
    const issue = data.issues.find((i) => i.id === issueId)
    if (!targetState || !issue) return

    setMutationInflight(workspaceId, true)
    const previousData = data
    const updatedIssues = data.issues.map((i) =>
      i.id === issueId ? { ...i, state: targetState } : i
    )
    useAppStore.setState((s) => ({
      linearBoardCache: { ...s.linearBoardCache, [workspaceId]: { ...data, issues: updatedIssues } }
    }))
    if (selectedIssue?.id === issueId) {
      setSelectedIssue({ ...issue, state: targetState })
    }

    try {
      await updateIssueState(decryptedKey, issueId, stateId)
    } catch (err: any) {
      useAppStore.setState((s) => ({
        linearBoardCache: { ...s.linearBoardCache, [workspaceId]: previousData }
      }))
      if (selectedIssue?.id === issueId) setSelectedIssue(issue)
      if (err?.message === 'LINEAR_FORBIDDEN' || err?.message === 'LINEAR_UNAUTHORIZED') {
        showToast('No permission to update issues')
      } else {
        showToast('Failed to update status')
      }
    } finally {
      setMutationInflight(workspaceId, false)
    }
  }, [data, workspaceId, decryptedKey, selectedIssue, showToast, setMutationInflight])

  const handleNavigate = useCallback((direction: 'up' | 'down') => {
    if (!selectedIssue || !data) return
    const columnIssues = data.issues.filter((i) => i.state.id === selectedIssue.state.id)
    const idx = columnIssues.findIndex((i) => i.id === selectedIssue.id)
    if (idx < 0) return
    const nextIdx = direction === 'up' ? idx - 1 : idx + 1
    if (nextIdx >= 0 && nextIdx < columnIssues.length) {
      setSelectedIssue(columnIssues[nextIdx])
    }
  }, [selectedIssue, data])

  const formatLastRefreshed = () => {
    if (!lastRefreshed) return ''
    const ago = Math.round((Date.now() - lastRefreshed) / 1000)
    if (ago < 5) return 'just now'
    if (ago < 60) return `${ago}s ago`
    return `${Math.round(ago / 60)}m ago`
  }

  // Empty state — no Linear config
  if (!linearConfig) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: txtColor }}>
        <span className="text-sm opacity-70">Connect Linear to see your team's board</span>
        <button
          onClick={onOpenSettings}
          className="text-xs px-3 py-1.5 rounded-md transition-opacity hover:opacity-80"
          style={{ backgroundColor: `${txtColor}15` }}
        >
          Open Settings
        </button>
      </div>
    )
  }

  // Loading state
  if (loading && !data) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: txtColor }}>
        <span className="text-sm opacity-50">Loading board...</span>
      </div>
    )
  }

  // Error state with no cached data
  if (error && !data) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: txtColor }}>
        <span className="text-sm opacity-70">{error}</span>
        <div className="flex gap-2">
          {(errorType === 'auth' || errorType === 'team') && (
            <button
              onClick={onOpenSettings}
              className="text-xs px-3 py-1.5 rounded-md transition-opacity hover:opacity-80"
              style={{ backgroundColor: `${txtColor}15` }}
            >
              Open Settings
            </button>
          )}
          <button
            onClick={refresh}
            className="text-xs px-3 py-1.5 rounded-md transition-opacity hover:opacity-80"
            style={{ backgroundColor: `${txtColor}15` }}
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* Board header */}
      <div className="flex items-center justify-between px-4 py-2 shrink-0 border-b" style={{ borderColor: `${txtColor}10` }}>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium" style={{ color: txtColor }}>{data.teamName}</span>
          <span className="text-xs opacity-40" style={{ color: txtColor }}>{data.issues.length} issues</span>
        </div>
        <div className="flex items-center gap-3">
          {error && (
            <span className="text-[10px] opacity-50" style={{ color: '#f76a6a' }}>{error}</span>
          )}
          {lastRefreshed && (
            <span className="text-[10px] opacity-30" style={{ color: txtColor }}>
              Updated {formatLastRefreshed()}
            </span>
          )}
          <button
            onClick={refresh}
            className="text-xs opacity-40 hover:opacity-100 transition-opacity"
            style={{ color: txtColor }}
            title="Refresh"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 4v4h4" />
              <path d="M15 12V8h-4" />
              <path d="M2.5 10.5A6 6 0 0 0 14 8" />
              <path d="M13.5 5.5A6 6 0 0 0 2 8" />
            </svg>
          </button>
        </div>
      </div>

      {/* Columns */}
      <div className="flex-1 flex overflow-x-auto overflow-y-hidden">
        {data.columns
          .filter((col) => col.type !== 'cancelled')
          .map((column) => {
            const columnIssues = data.issues.filter((i) => i.state.id === column.id)
            const isDragOver = dragOverColumn === column.id

            return (
              <div
                key={column.id}
                className="flex flex-col min-w-[260px] max-w-[320px] flex-1 border-r last:border-r-0"
                style={{ borderColor: `${txtColor}08` }}
                onDragOver={(e) => handleDragOver(e, column.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, column)}
              >
                {/* Column header */}
                <div className="flex items-center gap-2 px-3 py-2.5 shrink-0">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: column.color }}
                  />
                  <span className="text-xs font-medium truncate" style={{ color: txtColor }}>
                    {column.name}
                  </span>
                  <span className="text-[10px] opacity-30" style={{ color: txtColor }}>
                    {columnIssues.length}
                  </span>
                </div>

                {/* Cards */}
                <div
                  className="flex-1 overflow-y-auto px-2 pb-2 space-y-1.5 transition-colors"
                  style={{
                    backgroundColor: isDragOver
                      ? (isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.04)')
                      : 'transparent',
                  }}
                >
                  {columnIssues.map((issue) => (
                    <div
                      key={issue.id}
                      onDragEnd={handleDragEnd}
                    >
                      <LinearTicketCard
                        issue={issue}
                        txtColor={txtColor}
                        isLight={isLight}
                        onClick={() => setSelectedIssue(issue)}
                        onDragStart={(e) => handleDragStart(e, issue)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )
          })}

        {/* Detail panel */}
        {selectedIssue && (
          <LinearDetailPanel
            issue={selectedIssue}
            columns={data.columns}
            wsColor={wsColor}
            txtColor={txtColor}
            onClose={() => setSelectedIssue(null)}
            onStatusChange={handleStatusChange}
            onNavigate={handleNavigate}
          />
        )}
      </div>

      {/* Toast — absolute to board container */}
      {toast && (
        <div
          className="absolute bottom-4 right-4 px-4 py-2 rounded-lg text-sm shadow-lg z-50"
          style={{
            backgroundColor: toast.type === 'error' ? '#dc2626' : `${txtColor}15`,
            color: toast.type === 'error' ? '#fff' : txtColor,
          }}
        >
          {toast.message}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/LinearBoard.tsx
git commit -m "feat(linear): add LinearBoard kanban component with drag-and-drop"
```

---

## Task 9: Settings Dialog — Linear Configuration

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/SettingsDialog.tsx`

- [ ] **Step 1: Add 'linear' to SettingsPage type**

In `apps/desktop/src/renderer/src/components/SettingsDialog.tsx`, find:

```ts
type SettingsPage = 'index' | 'appearance' | 'notifications' | 'actions' | 'repository' | 'worktrees'
```

Change to:

```ts
type SettingsPage = 'index' | 'appearance' | 'notifications' | 'actions' | 'repository' | 'worktrees' | 'linear'
```

- [ ] **Step 2: Add Linear-related props to SettingsDialogProps**

Add to `SettingsDialogProps`:

```ts
  linearConfig?: { apiKey: string; teamId: string; teamName: string }
  onSaveLinearConfig: (config: { apiKey: string; teamId: string; teamName: string } | undefined) => void
```

Add these to the destructured props in the function signature.

- [ ] **Step 3: Add "Linear" menu item to the index page**

Find the settings index page rendering (the page list). Add a "Linear" entry with a board/kanban icon, positioned after "Repository". The exact insertion point depends on the existing layout — look for the other menu items and follow the same pattern.

- [ ] **Step 4: Add Linear state variables at top of component**

**Important:** React hooks cannot be called conditionally. Add these `useState` calls at the **top level** of the `SettingsDialog` function, alongside the existing state declarations (after line ~58):

```tsx
const [linearApiKey, setLinearApiKey] = useState('')
const [linearTeams, setLinearTeams] = useState<{ id: string; name: string; key: string }[]>([])
const [linearSelectedTeam, setLinearSelectedTeam] = useState<string>(linearConfig?.teamId ?? '')
const [linearLoading, setLinearLoading] = useState(false)
const [linearError, setLinearError] = useState<string | null>(null)
const [linearConnected, setLinearConnected] = useState(!!linearConfig)
```

Also add the handler functions (these can be inside the component body, just not inside JSX):

```tsx
const handleLinearKeySubmit = async () => {
  if (!linearApiKey.trim()) return
  setLinearLoading(true)
  setLinearError(null)
  try {
    const { fetchTeams } = await import('../utils/linear-client')
    const teams = await fetchTeams(linearApiKey.trim())
    setLinearTeams(teams)
    if (teams.length === 1) setLinearSelectedTeam(teams[0].id)
  } catch (err: any) {
    setLinearError(err?.message === 'LINEAR_UNAUTHORIZED' ? 'Invalid API key' : 'Failed to connect')
  } finally {
    setLinearLoading(false)
  }
}

const handleLinearSave = async () => {
  const team = linearTeams.find((t) => t.id === linearSelectedTeam)
  if (!team || !linearApiKey.trim()) return
  const encrypted = await window.electronAPI.linearEncryptKey(linearApiKey.trim())
  onSaveLinearConfig({ apiKey: encrypted, teamId: team.id, teamName: team.name })
  setLinearConnected(true)
  setLinearApiKey('')
  setLinearTeams([])
}

const handleLinearDisconnect = () => {
  onSaveLinearConfig(undefined)
  setLinearConnected(false)
  setLinearApiKey('')
  setLinearTeams([])
  setLinearSelectedTeam('')
}
```

- [ ] **Step 5: Add the Linear page JSX**

Add the `page === 'linear'` case in the page rendering switch. Follow the existing settings page patterns (look at how 'appearance' or 'notifications' pages are structured):

```tsx
{page === 'linear' && (
  <div className="space-y-4">
    <button onClick={() => setPage('index')} className="text-xs opacity-50 hover:opacity-100" style={{ color: txtColor }}>
      ← Back
    </button>
    <h3 className="text-sm font-semibold" style={{ color: txtColor }}>Linear Integration</h3>

    {linearConnected ? (
      <div className="space-y-3">
        <div className="text-sm opacity-70" style={{ color: txtColor }}>
          Connected to team: <strong>{linearConfig?.teamName}</strong>
        </div>
        <button
          onClick={handleLinearDisconnect}
          className="text-xs px-3 py-1.5 rounded-md hover:bg-white/10 transition-colors"
          style={{ color: txtColor, border: `1px solid ${txtColor}30` }}
        >
          Disconnect Linear
        </button>
      </div>
    ) : (
      <div className="space-y-3">
        <div>
          <label className="text-xs opacity-50 block mb-1" style={{ color: txtColor }}>API Key</label>
          <div className="flex gap-2">
            <input
              type="password"
              value={linearApiKey}
              onChange={(e) => setLinearApiKey(e.target.value)}
              placeholder="lin_api_..."
              className="flex-1 bg-black/10 border border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none"
              style={{ color: txtColor }}
            />
            <button
              onClick={handleLinearKeySubmit}
              disabled={!linearApiKey.trim() || linearLoading}
              className="text-xs px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 transition-colors disabled:opacity-50"
              style={{ color: txtColor }}
            >
              {linearLoading ? 'Loading...' : 'Connect'}
            </button>
          </div>
          {linearError && <p className="text-xs mt-1" style={{ color: '#f76a6a' }}>{linearError}</p>}
        </div>

        {linearTeams.length > 0 && (
          <div>
            <label className="text-xs opacity-50 block mb-1" style={{ color: txtColor }}>Team</label>
            <select
              value={linearSelectedTeam}
              onChange={(e) => setLinearSelectedTeam(e.target.value)}
              className="w-full bg-black/10 border border-white/10 rounded-md px-3 py-2 text-sm"
              style={{ color: txtColor }}
            >
              <option value="">Select a team</option>
              {linearTeams.map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({t.key})</option>
              ))}
            </select>
            <button
              onClick={handleLinearSave}
              disabled={!linearSelectedTeam}
              className="mt-3 text-xs px-4 py-2 rounded-md bg-white/10 hover:bg-white/20 transition-colors disabled:opacity-50"
              style={{ color: txtColor }}
            >
              Save
            </button>
          </div>
        )}
      </div>
    )}
  </div>
)}
```

- [ ] **Step 5: Verify build**

Run: `cd apps/desktop && bun run build`

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/SettingsDialog.tsx
git commit -m "feat(linear): add Linear configuration page in workspace settings"
```

---

## Task 10: Sidebar — View Mode Toggle

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Add view mode toggle between workspace header and content**

In `apps/desktop/src/renderer/src/components/Sidebar.tsx`, find the section where active workspace content is rendered (around line 1249: `{isActiveWs && !displayCollapsed && (`).

Before the existing content (trees, sessions), add a view toggle when `ws.linearConfig` is set:

```tsx
{/* View mode toggle */}
{ws.linearConfig && (
  <div className="flex items-center gap-0.5 px-2 py-1">
    {/* Orchestrator icon */}
    <button
      onClick={(e) => { e.stopPropagation(); updateWorkspace(ws.id, { viewMode: 'orchestrator' }) }}
      className="p-1 rounded transition-opacity"
      style={{
        color: txtColor,
        opacity: (!ws.viewMode || ws.viewMode === 'orchestrator') ? 1 : 0.35,
      }}
      title="Orchestrator"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4,12 4,14 12,14 12,12" />
        <rect x="2" y="2" width="12" height="10" rx="1" />
        <polyline points="5,7 7,9 11,5" />
      </svg>
    </button>
    {/* Board icon */}
    <button
      onClick={(e) => { e.stopPropagation(); updateWorkspace(ws.id, { viewMode: 'board' }) }}
      className="p-1 rounded transition-opacity"
      style={{
        color: txtColor,
        opacity: ws.viewMode === 'board' ? 1 : 0.35,
      }}
      title="Board"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1" y="2" width="4" height="12" rx="1" />
        <rect x="6" y="2" width="4" height="8" rx="1" />
        <rect x="11" y="2" width="4" height="10" rx="1" />
      </svg>
    </button>
  </div>
)}
```

- [ ] **Step 2: Conditionally hide trees/sessions in board mode**

Wrap the existing trees/sessions/worktree-button content with a guard:

```tsx
{(!ws.viewMode || ws.viewMode === 'orchestrator') && (
  // ... existing trees, sessions, action bar content ...
)}
```

- [ ] **Step 3: Show board summary in sidebar when board mode is active**

After the view toggle (when `ws.viewMode === 'board'`), show a compact summary:

```tsx
{ws.viewMode === 'board' && (
  <div className="px-3 py-1.5">
    <div className="text-[10px] opacity-50" style={{ color: txtColor }}>
      {ws.linearConfig?.teamName ?? 'Linear Board'}
    </div>
  </div>
)}
```

- [ ] **Step 4: Verify build**

Run: `cd apps/desktop && bun run build`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/Sidebar.tsx
git commit -m "feat(linear): add view mode toggle in sidebar"
```

---

## Task 11: App.tsx — Conditional Board Rendering

**Files:**
- Modify: `apps/desktop/src/renderer/src/App.tsx`

- [ ] **Step 1: Import LinearBoard**

Add at top of `apps/desktop/src/renderer/src/App.tsx`:

```ts
import { LinearBoard } from './components/LinearBoard'
```

- [ ] **Step 2: Replace TerminalArea with conditional rendering**

Find the section (around line 258-262):

```tsx
{diffSelectedFile ? (
  <DiffView file={diffSelectedFile} onClose={() => setDiffSelectedFile(null)} />
) : (
  <TerminalArea />
)}
```

Change to:

```tsx
{diffSelectedFile ? (
  <DiffView file={diffSelectedFile} onClose={() => setDiffSelectedFile(null)} />
) : activeWorkspace?.viewMode === 'board' ? (
  <LinearBoard
    workspaceId={activeWorkspace.id}
    linearConfig={activeWorkspace.linearConfig}
    wsColor={panelColor}
    onOpenSettings={() => {/* set showSettings state — see Task 12 */}}
  />
) : (
  <TerminalArea />
)}
```

Note: The `onOpenSettings` callback needs to trigger the settings dialog. Since `showSettings` state lives in `Sidebar.tsx`, the simplest approach is to lift a `showSettings` flag or use a store action. See Task 12 for wiring this up.

- [ ] **Step 3: Verify build**

Run: `cd apps/desktop && bun run build`

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(linear): conditionally render LinearBoard vs TerminalArea in App"
```

---

## Task 12: Wire Up Settings Dialog & onOpenSettings

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/renderer/src/store/app-store.ts`
- Modify: `apps/desktop/src/renderer/src/App.tsx`

- [ ] **Step 1: Add `showWorkspaceSettings` action to store**

In the store, add a simple boolean state so `App.tsx` can trigger the settings dialog:

```ts
  showWorkspaceSettings: boolean
  setShowWorkspaceSettings: (show: boolean) => void
```

Initial state: `showWorkspaceSettings: false`

Implementation:
```ts
  setShowWorkspaceSettings: (show) => set({ showWorkspaceSettings: show }),
```

- [ ] **Step 2: Wire settings dialog open from Sidebar using store**

In `Sidebar.tsx`, replace the local `showSettings` state with the store's `showWorkspaceSettings`:

```ts
const showSettings = useAppStore((s) => s.showWorkspaceSettings)
const setShowSettings = useAppStore((s) => s.setShowWorkspaceSettings)
```

- [ ] **Step 3: Pass Linear props to SettingsDialog**

Find where `<SettingsDialog>` is rendered in `Sidebar.tsx`. Add the new props:

```tsx
linearConfig={workspace?.linearConfig}
onSaveLinearConfig={(config) => {
  if (!workspace) return
  if (config) {
    updateWorkspace(workspace.id, { linearConfig: config })
  } else {
    // Disconnect: clear config and reset view
    updateWorkspace(workspace.id, { linearConfig: undefined, viewMode: 'orchestrator' })
    useAppStore.getState().clearLinearBoardCache(workspace.id)
  }
}}
```

- [ ] **Step 4: Wire onOpenSettings in App.tsx**

In `App.tsx`, wire the `onOpenSettings` prop on `LinearBoard`:

```tsx
onOpenSettings={() => useAppStore.getState().setShowWorkspaceSettings(true)}
```

- [ ] **Step 5: Verify build**

Run: `cd apps/desktop && bun run build`

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/Sidebar.tsx apps/desktop/src/renderer/src/store/app-store.ts apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(linear): wire SettingsDialog Linear props and onOpenSettings"
```

---

## Task 13: Final Build Verification & Manual Test

- [ ] **Step 1: Full build**

Run: `cd apps/desktop && bun run build`
Expected: Clean build, no errors

- [ ] **Step 2: Start dev server**

Run: `cd apps/desktop && bun run dev`
Expected: App launches without errors

- [ ] **Step 3: Manual smoke test checklist**

1. Open workspace settings — verify "Linear" page appears
2. Enter a Linear API key — verify team dropdown loads
3. Select team and save — verify view toggle appears in sidebar
4. Click board icon — verify kanban board renders in main area
5. Click a ticket — verify detail panel slides in
6. Change status via dropdown in detail panel
7. Drag a ticket to a different column
8. Click orchestrator icon — verify terminal area returns
9. Open settings, disconnect Linear — verify toggle disappears and view resets

- [ ] **Step 4: Commit any fixes from smoke testing**
