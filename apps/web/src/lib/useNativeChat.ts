'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import type { NativeChatCommand, NativeChatSnapshot } from '../../../desktop/src/shared/native-chat'
import { waitForNativeChatReceipt } from './native-chat-receipt'

const RECEIPT_TIMEOUT_MS = 60_000

type NativeUpload = { storageId: string; mime: string }
const UNCERTAIN_PENDING =
  'The desktop has not confirmed this command. It may still be pending; check the connection before retrying.'

export function useNativeChat(token: string, sessionId: string) {
  const convex = useConvex()
  const queried = useQuery(anyApi.nativeChat.getSession, { token, sessionId }) as
    | NativeChatSnapshot
    | null
    | undefined
  const [error, setError] = useState<string | null>(null)
  const activeSession = useRef<string | null>(sessionId)

  useEffect(() => {
    activeSession.current = sessionId
    setError(null)
    return () => {
      if (activeSession.current === sessionId) activeSession.current = null
    }
  }, [sessionId])

  const command = useCallback(
    async (value: NativeChatCommand, uploads?: NativeUpload[]) => {
      setError(null)
      try {
        const commandId = (await convex.mutation(anyApi.nativeChat.enqueue, {
          token,
          sessionId,
          command: value,
          ...(uploads && uploads.length > 0 ? { uploads } : {}),
        })) as string

        const watch = convex.watchQuery(anyApi.nativeChat.receipt, { token, commandId })
        await waitForNativeChatReceipt(watch, {
          timeoutMs: RECEIPT_TIMEOUT_MS,
          onTimeout: () => {
            if (activeSession.current === sessionId) setError(UNCERTAIN_PENDING)
          },
        })
        if (activeSession.current === sessionId) setError(null)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Native chat command failed'
        if (activeSession.current === sessionId) setError(message)
        throw cause
      }
    },
    [convex, sessionId, token],
  )

  return { snapshot: queried, loading: queried === undefined, error, command }
}
