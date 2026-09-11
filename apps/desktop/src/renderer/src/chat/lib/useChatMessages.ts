// The chat pane's message feed, desktop edition.
//
// On the phone this is a Convex one-shot backfill plus a `seq >` live-tail
// subscription. Here the messages never leave the machine: the main process
// already tails and parses every tracked session's transcript (agent-chat-log.ts),
// so the pane backfills from that log over IPC and then follows a push channel.
// Same rows, same seq semantics, same merge — see lib/chat-messages.
//
// The consequences worth knowing: this works with the remote bridge switched
// off, it costs no network, and a message appears as soon as the tailer parses
// it rather than a Convex round trip later.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChatFeedController, type ChatFeedSnapshot, PAGE_SIZE } from './chat-feed'
import type { SeqChatMessage } from './chat-messages'

/** One backfill page. Matches the log's own first-attach window closely enough
 *  that the first page usually IS the whole retained conversation. */
export { PAGE_SIZE }

export interface ChatFeed {
  messages: SeqChatMessage[]
  /** The backfill has answered (even with nothing) — an empty list now means
   *  "no conversation", not "still loading". */
  seeded: boolean
  hasEarlier: boolean
  loadingEarlier: boolean
  /** An earlier-page fetch failed; the auto-loader stands down behind a retry pill. */
  earlierError: boolean
  /**
   * Fetch the next earlier page. `beforeCommit` runs synchronously in the tick
   * the prepend is applied, with whether the page will actually add rows above
   * the viewport — that is the only moment the caller can capture scrollHeight
   * to hold the reader's place. An all-duplicate page (a retried fetch, overlap
   * with rows already held) reports false: an anchor armed by it would be
   * consumed by the NEXT live append and turn its stick-to-bottom pin into a
   * downward yank.
   */
  loadEarlier: (beforeCommit?: (willPrepend: boolean) => void) => Promise<void>
  /** The highest seq held — what an optimistic echo anchors itself above. */
  afterSeq: number
}

export function useChatMessages(sessionId: string): ChatFeed {
  const [snapshot, setSnapshot] = useState<ChatFeedSnapshot>({
    messages: [],
    seeded: false,
    hasEarlier: false,
    loadingEarlier: false,
    earlierError: false,
    afterSeq: -1,
  })
  const controllerRef = useRef<ChatFeedController | undefined>(undefined)

  // ── Backfill, then follow the push channel ────────────────────────────────
  useEffect(() => {
    const controller = new ChatFeedController(sessionId, {
      before: (id, beforeSeq, limit) => window.electronAPI.chatBefore(id, beforeSeq, limit),
      subscribe: (listener) => window.electronAPI.onChatLogEvent(listener),
    })
    controllerRef.current = controller
    setSnapshot(controller.getSnapshot())
    const unsubscribe = controller.subscribe(setSnapshot)
    controller.start()

    return () => {
      unsubscribe()
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = undefined
    }
  }, [sessionId])

  const loadEarlier = useCallback((beforeCommit?: (willPrepend: boolean) => void) => {
    return controllerRef.current?.loadEarlier(beforeCommit) ?? Promise.resolve()
  }, [])

  return { ...snapshot, loadEarlier }
}
