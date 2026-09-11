import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeChatCommand, NativeChatSnapshot } from '../../../../shared/native-chat'
import { newerNativeSnapshot } from '../../../../shared/native-chat-ui'

export function useNativeChat(sessionId: string) {
  const [snapshot, setSnapshot] = useState<NativeChatSnapshot | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef<string | null>(sessionId)

  useEffect(() => {
    sessionRef.current = sessionId
    setSnapshot(undefined)
    setError(null)
    let cancelled = false
    const apply = (incoming: NativeChatSnapshot | null) => {
      if (cancelled) return
      setSnapshot((current) => newerNativeSnapshot(current, incoming, sessionId))
    }
    const unsubscribe = window.electronAPI.onNativeChatState(apply)
    void window.electronAPI
      .nativeChatGet(sessionId)
      .then(apply)
      .catch((cause: unknown) => {
        if (cancelled) return
        setSnapshot(null)
        setError(cause instanceof Error ? cause.message : 'Could not load native chat')
      })
    return () => {
      cancelled = true
      if (sessionRef.current === sessionId) sessionRef.current = null
      unsubscribe()
    }
  }, [sessionId])

  const command = useCallback(async (value: NativeChatCommand) => {
    const commandSessionId = sessionRef.current
    if (!commandSessionId) throw new Error('Native chat is no longer mounted')
    setError(null)
    try {
      const next = await window.electronAPI.nativeChatCommand(commandSessionId, value)
      if (sessionRef.current === commandSessionId) {
        setSnapshot((current) => newerNativeSnapshot(current, next, commandSessionId))
      }
      return next
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Native chat command failed'
      if (sessionRef.current === commandSessionId) setError(message)
      throw cause
    }
  }, [])

  return { snapshot, loading: snapshot === undefined, error, command }
}
