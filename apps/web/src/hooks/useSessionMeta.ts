'use client'
import { useCallback } from 'react'
import { api, useSync } from '../lib/sync'

/** A message to deliver into the conversation once it is back up. */
export interface ResumeMessage {
  text: string
  images: { storageId: string; mime: string }[]
}

/**
 * Pin/unpin, rename, and resume a mirrored session from the phone.
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
export function useSessionMeta(): {
  setPinned: (sessionId: string, pinned: boolean) => void
  rename: (sessionId: string, title: string) => void
  resume: (sessionId: string, message?: ResumeMessage) => void
} {
  const sync = useSync()

  const setPinned = useCallback(
    (sessionId: string, pinned: boolean) => {
      void sync.call(api.remote.sendCommand, {
        sessionId,
        kind: 'setSessionPinned',
        payload: { pinned },
      })
    },
    [sync],
  )

  const rename = useCallback(
    (sessionId: string, title: string) => {
      void sync.call(api.remote.sendCommand, {
        sessionId,
        kind: 'renameSession',
        // Blank clears the custom name and hands the session back to its auto label.
        payload: { title: title.trim().slice(0, 200) },
      })
    },
    [sync],
  )

  /**
   * Reopen a pane on the conversation it was holding. Carries no conversation
   * id: the desktop recorded which one this pane had and is the only thing that
   * can spawn it, so the phone names the session and nothing else.
   *
   * `message` resumes the session AND delivers text into it, so the reopened
   * conversation reads it as the first thing. The desktop waits out the boot and clears any gate
   * on the way (remote-bridge-resume-send) — the phone cannot, because it has
   * no view of the screen the gate is drawn on.
   */
  const resume = useCallback(
    (sessionId: string, message?: ResumeMessage) => {
      void sync.call(api.remote.sendCommand, {
        sessionId,
        kind: 'resumeSession',
        payload: message ?? {},
      })
    },
    [sync],
  )

  return { setPinned, rename, resume }
}
