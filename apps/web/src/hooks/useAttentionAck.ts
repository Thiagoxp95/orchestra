'use client'
import { useState, useSyncExternalStore } from 'react'
import { nextAcknowledged, type AckStatusLike } from '@/lib/attention-ack'

/** Whether the tab/PWA is actually on screen — see useAttentionAck. */
function subscribeVisibility(onStoreChange: () => void) {
  document.addEventListener('visibilitychange', onStoreChange)
  return () => document.removeEventListener('visibilitychange', onStoreChange)
}

function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === 'visible',
    // The server (and the first client render) assume visible: this only ever
    // gates *acknowledging*, and starting out unacknowledged is the safe side.
    () => true,
  )
}

/**
 * The set of sessions whose needs-input signal the user has already seen —
 * strip it from the mirrored statuses with applyAttentionAck.
 *
 * `viewing` is the session on screen right now, and null whenever it isn't
 * really being looked at: the overview covering it, nothing open, or the phone
 * backgrounded (checked here, so a pocketed phone with a session open can't
 * silence a question it never showed anyone).
 */
export function useAttentionAck(
  liveStatus: Record<string, AckStatusLike | undefined>,
  viewing: string | null,
): ReadonlySet<string> {
  const [acked, setAcked] = useState<ReadonlySet<string>>(() => new Set<string>())
  const visible = usePageVisible()

  // Derived during render, not in an effect: the answer is a pure function of
  // what we already have (the mirror, what's on screen, whether anyone is
  // looking), so an effect would only publish it one paint late — long enough
  // for the card you just left to flash its badge again. React's
  // "adjust state during render" pattern; it converges because nextAcknowledged
  // returns null the moment nothing is left to change.
  const next = nextAcknowledged(acked, liveStatus, visible ? viewing : null)
  if (next) setAcked(next)

  return next ?? acked
}
