'use client'
// Reads for the pull-request page. GitHub is the source of truth, so these are
// one-shot calls to the desktop (which runs `gh`), refreshed on an interval
// while the page is open and on demand after an action — not hub subscriptions.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, useSync } from '@/lib/sync'
import type { GitHubRepo, Involvement, PullAction, PullDetail, PullSummary, StateFilter } from '@/lib/github'

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

export function usePullList(rootDir: string, filter: { state: StateFilter; involvement: Involvement; query: string }) {
  const sync = useSync()
  const key = JSON.stringify([rootDir, filter.state, filter.involvement, filter.query])
  return useRemote<{ repo: GitHubRepo; pulls: PullSummary[] }>(
    key,
    () => sync.call(api.github.listPulls, { rootDir, ...filter }) as Promise<{ repo: GitHubRepo; pulls: PullSummary[] }>,
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
