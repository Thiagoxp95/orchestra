'use client'
import { useCallback } from 'react'
import { api, useSync } from '../lib/sync'

/**
 * Close a mirrored session from the phone: kill its PTY and drop its row.
 *
 * The desktop's 'kill' handler does both halves — daemon.kill terminates the PTY,
 * then it forwards the removal to the renderer so the next state push comes back
 * without the session. Killing alone would leave the row in the renderer store and
 * the next push would re-add it, which is what made the web's swipe-to-trash look
 * inert before (see remote-bridge's 'kill' case).
 *
 * This is the same command the sidebar's swipe-to-trash sends; it lives here so the
 * roll's leftward two-finger swipe and any future caller agree on what "close" does
 * rather than each re-deriving the payload.
 *
 * Irreversible for the running process: the agent's conversation can be resumed
 * later from the resume drawer, but whatever was in flight is gone. Callers are
 * expected to have earned the gesture before calling (see closeCommit).
 */
export function useCloseSession(): (sessionId: string) => void {
  const sync = useSync()
  return useCallback(
    (sessionId: string) => {
      void sync.call(api.remote.sendCommand, { sessionId, kind: 'kill', payload: {} })
    },
    [sync],
  )
}
