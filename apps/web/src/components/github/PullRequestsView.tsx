'use client'
// Orchestra's own GitHub page: every workspace's pull requests, read and acted
// on through the desktop's `gh` login. A workspace is a repository here — its
// worktrees all share one remote — so the chips across the top pick the repo.
// On a phone the list and a PR take turns on screen; wider, they sit side by
// side the way t3code lays them out.

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { useNow } from '@/hooks/use-now'
import { workspaceDisplayEmoji } from '@/lib/workspace-emoji'
import { SORT_LABEL, mergeSeenAuthors, type GitHubUser, type Involvement, type PullSort, type StateFilter } from '@/lib/github'
import { PullRequestList, type ListFilter } from './PullRequestList'
import { PullRequestDetail } from './PullRequestDetail'
import { ToastHost } from './pr-ui'
import { usePullAction, usePullDetail, usePullList } from './usePullRequests'

export interface PullRequestsTarget {
  /** A mirrored worktree root: decides the repository `gh` runs against. */
  rootDir: string
  /** The PR open in it, if any. */
  number?: number
}

interface MirroredWorkspace {
  id: string
  name: string
  emoji?: string
  trees: { rootDir: string; sessionIds: string[]; branch?: string }[]
}

// Every filter survives a reload (this device's localStorage). Authors are
// kept per workspace — they're people on that repo — and so is the roster the
// author picker offers (see mergeSeenAuthors).
const PREFS_KEY = 'orchestra.pullRequests.preferences'
const seenKey = (workspaceId: string) => `orchestra.pullRequests.seenAuthors:${workspaceId}`

interface Prefs {
  state: StateFilter
  involvement: Involvement
  sort: PullSort
  query: string
  authorsByWorkspace: Record<string, string[]>
}

const DEFAULT_PREFS: Prefs = { state: 'open', involvement: 'all', sort: 'ready', query: '', authorsByWorkspace: {} }

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>
    const authorsByWorkspace: Record<string, string[]> = {}
    for (const [ws, list] of Object.entries(raw.authorsByWorkspace ?? {})) {
      if (Array.isArray(list)) authorsByWorkspace[ws] = list.filter((a): a is string => typeof a === 'string')
    }
    return {
      state: (['open', 'closed', 'merged', 'all'] as StateFilter[]).find((s) => s === raw.state) ?? 'open',
      involvement: (['all', 'reviewing', 'authored'] as Involvement[]).find((s) => s === raw.involvement) ?? 'all',
      sort: (Object.keys(SORT_LABEL) as PullSort[]).find((s) => s === raw.sort) ?? 'ready',
      query: typeof raw.query === 'string' ? raw.query : '',
      authorsByWorkspace,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

function readSeen(workspaceId: string | undefined): GitHubUser[] {
  if (!workspaceId) return []
  try {
    const raw = JSON.parse(localStorage.getItem(seenKey(workspaceId)) ?? '[]') as GitHubUser[]
    return Array.isArray(raw) ? raw.filter((u) => u && typeof u.login === 'string') : []
  } catch {
    return []
  }
}

export function PullRequestsView({
  workspaces,
  target,
  onTarget,
  onOpenSession,
}: {
  workspaces: MirroredWorkspace[]
  target: PullRequestsTarget
  onTarget: (t: PullRequestsTarget) => void
  onOpenSession: (sessionId: string) => void
}) {
  const now = useNow(30_000)
  // Only ever mounted client-side (after a tap or the page's post-mount
  // restore), so localStorage is there on the first render.
  const [prefs, setPrefs] = useState<Prefs>(readPrefs)
  const [searchDraft, setSearchDraft] = useState(prefs.query)

  const repos = workspaces.filter((ws) => ws.trees.length > 0)
  const activeWs = repos.find((ws) => ws.trees.some((t) => t.rootDir === target.rootDir))

  const filter: ListFilter = {
    state: prefs.state,
    involvement: prefs.involvement,
    sort: prefs.sort,
    query: prefs.query,
    authors: (activeWs && prefs.authorsByWorkspace[activeWs.id]) || [],
  }
  const updateFilter = (patch: Partial<ListFilter>) =>
    setPrefs((cur) => {
      const { authors, ...rest } = patch
      const next: Prefs = { ...cur, ...rest }
      if (authors && activeWs) next.authorsByWorkspace = { ...cur.authorsByWorkspace, [activeWs.id]: authors }
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      } catch {}
      return next
    })

  const list = usePullList(target.rootDir, filter)

  // The author picker's roster: remembered for this workspace, topped up from
  // every list that loads, and written back so it outlives the filter.
  const wsId = activeWs?.id
  const listData = list.data
  const authorOptions = mergeSeenAuthors(readSeen(wsId), listData?.pulls ?? [])
  const roster = listData ? JSON.stringify(authorOptions) : null
  useEffect(() => {
    if (!wsId || !roster) return
    try {
      localStorage.setItem(seenKey(wsId), roster)
    } catch {}
  }, [wsId, roster])
  const detail = usePullDetail(target.rootDir, target.number)
  const runAction = usePullAction(target.rootDir)

  // The worktree checked out on a PR's branch, if one has a session running.
  const sessionForBranch = (branch: string): string | null => {
    for (const tree of activeWs?.trees ?? []) {
      if (tree.branch === branch && tree.sessionIds.length > 0) return tree.sessionIds[0]
    }
    return null
  }

  const open = (number: number) => onTarget({ rootDir: target.rootDir, number })
  const back = () => onTarget({ rootDir: target.rootDir })

  return (
    <ToastHost>
      <div className="flex h-full min-h-0 flex-col">
        {repos.length > 1 && (
          <nav aria-label="Repository" className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-border/60 px-3 py-2">
            {repos.map((ws, i) => (
              <button
                key={ws.id}
                type="button"
                aria-pressed={ws.id === activeWs?.id}
                onClick={() => {
                  if (ws.id === activeWs?.id) return
                  setSearchDraft('')
                  updateFilter({ query: '' })
                  onTarget({ rootDir: ws.trees[0].rootDir })
                }}
                className={cn(
                  'flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
                  ws.id === activeWs?.id
                    ? 'border-foreground/40 bg-foreground/10 text-foreground'
                    : 'border-border text-muted-foreground active:bg-accent',
                )}
              >
                <span aria-hidden>{workspaceDisplayEmoji(ws.emoji, i)}</span>
                {ws.name}
              </button>
            ))}
          </nav>
        )}
        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              'min-h-0 flex-col lg:flex lg:w-[26rem] lg:shrink-0 lg:border-r lg:border-border/60',
              target.number ? 'hidden' : 'flex flex-1 lg:flex-none',
            )}
          >
            {list.data?.repo && (
              <div className="flex shrink-0 items-center gap-2 px-4 pt-2 text-[11px] text-muted-foreground">
                <a href={list.data.repo.url} target="_blank" rel="noreferrer" className="truncate hover:underline">
                  {list.data.repo.nameWithOwner}
                </a>
                <span className="ml-auto shrink-0">{list.data.pulls.length} shown</span>
              </div>
            )}
            <PullRequestList
              pulls={list.data?.pulls}
              viewer={list.data?.repo.viewerLogin ?? ''}
              authorOptions={authorOptions}
              filter={filter}
              onFilter={updateFilter}
              searchDraft={searchDraft}
              onSearchDraft={setSearchDraft}
              loading={list.loading}
              error={list.error}
              onRefresh={list.refresh}
              selected={target.number}
              onOpen={open}
              now={now}
            />
          </div>
          <div className={cn('min-h-0 flex-1 flex-col', target.number ? 'flex' : 'hidden lg:flex')}>
            {target.number ? (
              <PullRequestDetail
                key={`${target.rootDir}#${target.number}`}
                rootDir={target.rootDir}
                pr={detail.data}
                loading={detail.loading}
                error={detail.error}
                onBack={back}
                onRefresh={() => {
                  detail.refresh()
                  list.refresh()
                }}
                run={runAction}
                sessionForBranch={sessionForBranch}
                onOpenSession={onOpenSession}
                now={now}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                Pick a pull request
              </div>
            )}
          </div>
        </div>
      </div>
    </ToastHost>
  )
}
