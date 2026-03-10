import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore } from '../store/app-store'
import type { IdleNotification } from '../../../shared/types'
import type { ToastEntry } from '../components/Toast'
import defaultSoundUrl from '../assets/sounds/default-notification.mp3'

// Cache data URLs for custom sounds to avoid re-reading on every notification
const soundCache = new Map<string, string>()

async function playNotificationSound(soundPath: string | undefined): Promise<void> {
  try {
    let url: string
    if (!soundPath) {
      url = defaultSoundUrl
    } else {
      const cached = soundCache.get(soundPath)
      if (cached) {
        url = cached
      } else {
        const dataUrl = await window.electronAPI.readFileAsDataUrl(soundPath)
        if (!dataUrl) {
          url = defaultSoundUrl
        } else {
          soundCache.set(soundPath, dataUrl)
          url = dataUrl
        }
      }
    }
    const audio = new Audio(url)
    audio.volume = 0.5
    await audio.play()
  } catch {
    // Ignore audio playback errors
  }
}

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

      // Play notification sound for the session's workspace
      const state = useAppStore.getState()
      const session = state.sessions[notification.sessionId]
      const workspace = session ? state.workspaces[session.workspaceId] : null
      void playNotificationSound(workspace?.notificationSound)

      const timer = setTimeout(() => {
        dismissToast(id)
        timersRef.current.delete(id)
      }, 10000)
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
