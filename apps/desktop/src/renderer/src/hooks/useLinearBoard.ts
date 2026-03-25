import { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../store/app-store'
import { fetchBoardData } from '../utils/linear-client'
import type { LinearBoardData } from '../../../shared/linear-types'

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
  decryptedKey: string | null
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
      console.error('[useLinearBoard] fetch error:', err)
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
          schedulePoll()
        }
      }, pollIntervalRef.current)
    }
    schedulePoll()

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
