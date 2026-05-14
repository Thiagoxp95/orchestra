import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore } from '../store/app-store'
import type { IdleNotification } from '../../../shared/types'
import type { ToastEntry } from '../components/Toast'
import defaultSoundUrl from '../assets/sounds/default-notification.mp3'

// Cache data URLs for custom sounds to avoid re-reading on every notification
const soundCache = new Map<string, string>()

async function resolveSoundUrl(soundPath: string | undefined): Promise<string> {
  if (!soundPath) {
    return defaultSoundUrl
  }

  const cached = soundCache.get(soundPath)
  if (cached) {
    return cached
  }

  const dataUrl = await window.electronAPI.readFileAsDataUrl(soundPath)
  if (!dataUrl) {
    return defaultSoundUrl
  }

  soundCache.set(soundPath, dataUrl)
  return dataUrl
}

async function playNotificationSound(
  soundPath: string | undefined,
  questionSoundPath: string | undefined,
  requiresUserInput: boolean
): Promise<void> {
  try {
    const url = await resolveSoundUrl(requiresUserInput ? (questionSoundPath ?? soundPath) : soundPath)
    const audio = new Audio(url)
    audio.volume = 0.5
    await audio.play()
  } catch {
    // Ignore audio playback errors
  }
}

function isGenericSessionLabel(label: string): boolean {
  return /^(?:Claude|Codex|Terminal)(?:\s+\d+)?$/.test(label.trim())
}

function resolveSessionTitle(notification: IdleNotification): string {
  const state = useAppStore.getState()
  const label = state.sessions[notification.sessionId]?.label?.replace(/\s+/g, ' ').trim()
  if (label && !isGenericSessionLabel(label)) return label
  return notification.sessionTitle || notification.title
}

export function useIdleNotifications() {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const setSessionNeedsUserInput = useAppStore((s) => s.setSessionNeedsUserInput)

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
      // Suppress "needs input" notifications when the session is currently
      // working — these states are mutually exclusive. A stale notification
      // from a momentary idle blip or a stray OSC notification fired mid-turn
      // must not flash a toast or sound for a session whose spinner is
      // actively spinning. Only guard on requiresUserInput=true so
      // "finished" notifications (which toggle the flag off) still pass.
      if (notification.requiresUserInput) {
        const cached = useAppStore.getState().normalizedAgentState[notification.sessionId]
        if (cached?.connected && cached.state === 'working') return
      }

      // Always update needsUserInput state (even if user is looking at the session)
      setSessionNeedsUserInput(notification.sessionId, notification.requiresUserInput)

      // Skip toast and sound when user is actively looking at this session
      if (notification.showToast === false) return

      const id = crypto.randomUUID()

      // Look up workspace for color and notification sound
      const state = useAppStore.getState()
      const session = state.sessions[notification.sessionId]
      const workspace = session ? state.workspaces[session.workspaceId] : null
      const enrichedNotification = {
        ...notification,
        sessionTitle: resolveSessionTitle(notification),
      }

      // Replace any existing toast for this session — each session gets only one active toast.
      // Prevents duplicate "finished" + "needs input" toasts when work state bounces.
      setToasts((prev) => {
        const filtered = prev.filter((t) => t.sessionId !== notification.sessionId)
        return [...filtered, { ...enrichedNotification, id, fadingOut: false, workspaceColor: workspace?.color }]
      })

      if (!state.settings.notificationSoundsMuted) {
        void playNotificationSound(
          workspace?.notificationSound,
          workspace?.questionNotificationSound,
          notification.requiresUserInput
        )
      }

      const timer = setTimeout(() => {
        dismissToast(id)
        timersRef.current.delete(id)
      }, 30000)
      timersRef.current.set(id, timer)
    })

    // Upgrade toast title when the async LLM summary arrives
    const cleanupSummary = window.electronAPI.onIdleNotificationSummaryUpdate?.((update) => {
      setToasts((prev) => prev.map((t) =>
        t.sessionId === update.sessionId
          ? {
              ...t,
              title: update.title,
              sessionTitle: t.sessionTitle === t.title ? update.title : t.sessionTitle,
            }
          : t
      ))
    })

    return () => {
      cleanup()
      cleanupSummary?.()
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [dismissToast, setSessionNeedsUserInput])

  return { toasts, dismissToast, navigateToSession }
}
