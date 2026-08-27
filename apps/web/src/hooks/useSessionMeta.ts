'use client'
import { useCallback } from 'react'
import { useConvex } from 'convex/react'
import { anyApi } from 'convex/server'

/**
 * Pin/unpin and rename a mirrored session from the phone.
 *
 * Both are commands, not local state: the desktop's renderer store owns
 * `pinned` and `customLabel` (they persist in orchestra-data.json with the rest
 * of the session), so the phone asks and reads the answer back off the next
 * state push — the same round trip swipe-to-trash makes. That keeps one source
 * of truth and means a rename typed on the phone shows up in the desktop
 * sidebar, in notifications, and in the resume drawer without a second path.
 *
 * The push is ~10s at worst but usually immediate (a store change triggers one),
 * so callers that want the title to settle instantly should render optimistically
 * and let the mirror reconcile.
 */
export function useSessionMeta(token: string): {
  setPinned: (sessionId: string, pinned: boolean) => void
  rename: (sessionId: string, title: string) => void
} {
  const convex = useConvex()

  const setPinned = useCallback(
    (sessionId: string, pinned: boolean) => {
      void convex.mutation(anyApi.remote.sendCommand, {
        token,
        sessionId,
        kind: 'setSessionPinned',
        payload: { pinned },
      })
    },
    [convex, token],
  )

  const rename = useCallback(
    (sessionId: string, title: string) => {
      void convex.mutation(anyApi.remote.sendCommand, {
        token,
        sessionId,
        kind: 'renameSession',
        // Blank clears the custom name and hands the session back to its auto label.
        payload: { title: title.trim().slice(0, 200) },
      })
    },
    [convex, token],
  )

  return { setPinned, rename }
}
