import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore } from '../store/app-store'
import type { WebhookEventToast } from '../../../shared/types'
import type { WebhookToastEntry } from '../components/WebhookToast'

export function useWebhooks() {
  const [webhookToasts, setWebhookToasts] = useState<WebhookToastEntry[]>([])
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismissWebhookToast = useCallback((id: string) => {
    setWebhookToasts((prev) => prev.map((t) => (t.id === id ? { ...t, fadingOut: true } : t)))
    setTimeout(() => {
      setWebhookToasts((prev) => prev.filter((t) => t.id !== id))
    }, 300)
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const toggleWebhookToastExpand = useCallback((id: string) => {
    setWebhookToasts((prev) => prev.map((t) => (t.id === id ? { ...t, expanded: !t.expanded } : t)))
  }, [])

  useEffect(() => {
    const unsubRun = window.electronAPI.onWebhookRunAction(({ workspaceId, actionId }) => {
      const state = useAppStore.getState()
      const workspace = state.workspaces[workspaceId]
      if (!workspace) return
      const action = workspace.customActions.find((a) => a.id === actionId)
      if (!action) return
      state.runAction(workspaceId, action, { forceDefaultTree: true })
    })

    // Dev-only: webhook event notifications for toast display
    let unsubNotify: (() => void) | undefined
    if (import.meta.env.DEV) {
      unsubNotify = window.electronAPI.onWebhookEventNotification((data: WebhookEventToast) => {
        const id = crypto.randomUUID()
        setWebhookToasts((prev) => [...prev, { ...data, id, fadingOut: false, expanded: false }])
        const timer = setTimeout(() => dismissWebhookToast(id), 15_000)
        timersRef.current.set(id, timer)
      })
    }

    return () => {
      unsubRun()
      unsubNotify?.()
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [dismissWebhookToast])

  return { webhookToasts, dismissWebhookToast, toggleWebhookToastExpand }
}
