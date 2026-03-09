import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore } from '../store/app-store'
import type { IdleNotification } from '../../../shared/types'
import type { ToastEntry } from '../components/Toast'

export function useIdleNotifications() {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.map((t) => t.id === id ? { ...t, fadingOut: true } : t))
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 300)
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const navigateToSession = useCallback((sessionId: string) => {
    useAppStore.getState().setActiveSession(sessionId)
  }, [])

  useEffect(() => {
    const cleanup = window.electronAPI.onIdleNotification((notification: IdleNotification) => {
      const id = crypto.randomUUID()
      const entry: ToastEntry = { ...notification, id, fadingOut: false }
      setToasts((prev) => [...prev, entry])

      const timer = setTimeout(() => {
        dismissToast(id)
        timersRef.current.delete(id)
      }, 5000)
      timersRef.current.set(id, timer)
    })

    return () => {
      cleanup()
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [dismissToast])

  return { toasts, dismissToast, navigateToSession }
}
