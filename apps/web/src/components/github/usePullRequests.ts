'use client'
// Reads for the pull-request page. GitHub is the source of truth, so these are
// one-shot calls to the desktop (which runs `gh`), refreshed on an interval
// while the page is open and on demand after an action — not hub subscriptions.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, useSync } from '@/lib/sync'
import {
  SORT_LABEL,
  type GitHubRepo,
  type Involvement,
  type PullAction,
  type PullDetail,
  type PullSort,
  type PullSummary,
  type StateFilter,
} from '@/lib/github'

// Every filter survives a reload (this device's localStorage). Authors are
// kept per workspace — they're people on that repo — and so is the roster the
// author picker offers (see mergeSeenAuthors).
const PREFS_KEY = 'orchestra.pullRequests.preferences'
/** Fired on every save, so the sidebar's badge recounts under the new filters. */
const PREFS_EVENT = 'orchestra:pull-prefs'

export interface PullPrefs {
  state: StateFilter
  involvement: Involvement
  sort: PullSort
  query: string
  authorsByWorkspace: Record<string, string[]>
}

const DEFAULT_PREFS: PullPrefs = { state: 'open', involvement: 'all', sort: 'ready', query: '', authorsByWorkspace: {} }

export function readPullPrefs(): PullPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<PullPrefs>
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

export function savePullPrefs(prefs: PullPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {}
  window.dispatchEvent(new Event(PREFS_EVENT))
}

interface Remote<T> {
  data: T | undefined
  error: string | null
  loading: boolean
  refresh: () => void
}

/**
 * Fetch `key`'s value now and every `intervalMs` while the tab is visible.
 * A new key drops the old value (another repo's list must never show under
 * this one); a refresh of the same key keeps it on screen until the answer.
 */
function useRemote<T>(key: string | null, fetcher: () => Promise<T>, intervalMs: number): Remote<T> {
  const [state, setState] = useState<{ key: string | null; data?: T; error: string | null; loading: boolean }>({
    key: null,
    error: null,
    loading: false,
  })
  // The latest fetcher without re-arming the interval on every render.
  const fetchRef = useRef(fetcher)
  useEffect(() => {
    fetchRef.current = fetcher
  })
  const seq = useRef(0)

  // Only the answer is set from here; "loading" for a new key is derived below,
  // and a same-key refresh marks itself from the event that asked for it.
  const fetchNow = useCallback(() => {
    if (!key) return
    const mine = ++seq.current
    fetchRef.current().then(
      (data) => mine === seq.current && setState({ key, data, error: null, loading: false }),
      (err: unknown) =>
        mine === seq.current &&
        // Keep the last answer only if it's this key's: another repo's list
        // must never sit under this one's chip.
        setState((s) => ({
          key,
          data: s.key === key ? s.data : undefined,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        })),
    )
  }, [key])

  const run = useCallback(() => {
    setState((s) => (s.key === key ? { ...s, loading: true } : s))
    fetchNow()
  }, [key, fetchNow])

  useEffect(() => {
    fetchNow()
    if (!key) return
    const timer = setInterval(() => document.visibilityState === 'visible' && run(), intervalMs)
    const onVisible = () => document.visibilityState === 'visible' && run()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [key, run, fetchNow, intervalMs])

  const fresh = state.key === key
  return { data: fresh ? state.data : undefined, error: fresh ? state.error : null, loading: !fresh || state.loading, refresh: run }
}

export function usePullList(
  rootDir: string,
  filter: { state: StateFilter; involvement: Involvement; query: string; authors: string[] },
) {
  const sync = useSync()
  const { state, involvement, query, authors } = filter
  const key = JSON.stringify([rootDir, state, involvement, query, authors])
  return useRemote<{ repo: GitHubRepo; pulls: PullSummary[] }>(
    key,
    () =>
      sync.call(api.github.listPulls, { rootDir, state, involvement, query, authors }) as Promise<{
        repo: GitHubRepo
        pulls: PullSummary[]
      }>,
    60_000,
  )
}

export function usePullDetail(rootDir: string, number: number | undefined) {
  const sync = useSync()
  return useRemote<PullDetail>(
    number ? `${rootDir}#${number}` : null,
    () => sync.call(api.github.getPull, { rootDir, number }) as Promise<PullDetail>,
    20_000,
  )
}

export function usePullDiff(rootDir: string, number: number, enabled: boolean) {
  const sync = useSync()
  return useRemote<string>(
    enabled ? `${rootDir}#${number}:diff` : null,
    () => sync.call(api.github.getPullDiff, { rootDir, number }) as Promise<string>,
    120_000,
  )
}

export function usePullAction(rootDir: string) {
  const sync = useSync()
  return useCallback(
    (number: number, action: PullAction) => sync.call(api.github.runPullAction, { rootDir, number, action }) as Promise<null>,
    [sync, rootDir],
  )
}

/**
 * The sidebar badge: how many PRs every workspace's repo holds under the
 * filters picked for it on the PR page (state and involvement are shared,
 * authors are per workspace; the search box is a passing lookup, not a filter,
 * so it's left out). One `gh` search per repo, so it polls slowly.
 */
export function usePullCount(workspaces: { id: string; trees: { rootDir: string }[] }[]): number | undefined {
  const sync = useSync()
  const [prefs, setPrefs] = useState<PullPrefs | null>(null)
  useEffect(() => {
    const load = () => setPrefs(readPullPrefs())
    load()
    window.addEventListener(PREFS_EVENT, load)
    window.addEventListener('storage', load)
    return () => {
      window.removeEventListener(PREFS_EVENT, load)
      window.removeEventListener('storage', load)
    }
  }, [])

  const queries = prefs
    ? workspaces
        .filter((ws) => ws.trees.length > 0)
        .map((ws) => ({
          rootDir: ws.trees[0].rootDir,
          state: prefs.state,
          involvement: prefs.involvement,
          query: '',
          authors: prefs.authorsByWorkspace[ws.id] ?? [],
        }))
    : []
  const key = queries.length ? JSON.stringify(queries) : null
  const count = useRemote<number>(
    key,
    async () => {
      // A repo `gh` can't read (no remote, not GitHub) just adds nothing.
      const lists = await Promise.allSettled(
        queries.map((q) => sync.call(api.github.listPulls, q) as Promise<{ pulls: PullSummary[] }>),
      )
      return lists.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value.pulls.length : 0), 0)
    },
    300_000,
  )
  return count.data
}
