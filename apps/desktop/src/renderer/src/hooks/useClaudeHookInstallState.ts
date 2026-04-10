import { useEffect, useState } from 'react'
import type { ClaudeHookInstallState } from '../../../shared/types'

export function useClaudeHookInstallState(): {
  state: ClaudeHookInstallState | null
  refresh: () => void
  install: () => Promise<{ ok: boolean; reason?: string; detail?: string }>
} {
  const [state, setState] = useState<ClaudeHookInstallState | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.claudeHooks.getState().then((s) => {
      if (!cancelled) setState(s)
    })
    const unsub = window.electronAPI.claudeHooks.onStateChanged((s) => {
      setState(s)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  const refresh = () => {
    window.electronAPI.claudeHooks.getState().then(setState)
  }
  const install = () => window.electronAPI.claudeHooks.install()

  return { state, refresh, install }
}
