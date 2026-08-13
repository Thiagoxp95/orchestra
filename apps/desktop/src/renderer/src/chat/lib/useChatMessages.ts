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
import type { AgentChatLogEvent, AgentChatRow } from '../../../../shared/types'
import { mergeMessages, type ChatBlock, type ChatMessage, type SeqChatMessage } from './chat-messages'

/** One backfill page. Matches the log's own first-attach window closely enough
 *  that the first page usually IS the whole retained conversation. */
export const PAGE_SIZE = 60

const ROLES: readonly string[] = ['user', 'assistant', 'tool', 'system']

/** A row off the wire, narrowed. An unknown role from a newer main process
 *  renders as a system line rather than crashing the pane. */
function toMessage(row: AgentChatRow): SeqChatMessage {
  return {
    uid: row.uid,
    seq: row.seq,
    role: ROLES.includes(row.role) ? (row.role as ChatMessage['role']) : 'system',
    blocks: Array.isArray(row.blocks) ? (row.blocks as ChatBlock[]) : [],
    ts: row.ts,
  }
}

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
  const [messages, setMessages] = useState<SeqChatMessage[]>([])
  const [seeded, setSeeded] = useState(false)
  const [hasEarlier, setHasEarlier] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [earlierError, setEarlierError] = useState(false)
  // Single live cursor: the highest merged seq. Held in a ref as well as state
  // because the push handler reads it outside React's render cycle.
  const afterSeqRef = useRef(-1)
  const [afterSeq, setAfterSeq] = useState(-1)

  const absorb = useCallback((rows: AgentChatRow[]) => {
    if (rows.length === 0) return
    const incoming = rows.map(toMessage)
    setMessages((prev) => mergeMessages(prev, incoming))
    const top = incoming.reduce((n, m) => Math.max(n, m.seq), afterSeqRef.current)
    afterSeqRef.current = top
    setAfterSeq(top)
  }, [])

  // ── Backfill, then follow the push channel ────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setMessages([])
    setSeeded(false)
    setHasEarlier(false)
    setEarlierError(false)
    afterSeqRef.current = -1
    setAfterSeq(-1)

    // Subscribed BEFORE the backfill resolves: a message parsed in that window
    // would otherwise fall between the two and never render (the log is a push
    // channel, so nothing replays it). Overlap is free — the merge is by uid.
    const unsubscribe = window.electronAPI.onChatLogEvent((event: AgentChatLogEvent) => {
      if (cancelled || event.sessionId !== sessionId) return
      if (event.kind === 'clear') {
        // The desktop swapped this session to a different conversation. The
        // in-band `reset` marker that follows is what the timeline cuts on;
        // dropping the rows here as well keeps memory honest.
        setMessages([])
        return
      }
      absorb(event.messages)
    })

    void window.electronAPI
      .chatBefore(sessionId, Number.MAX_SAFE_INTEGER, PAGE_SIZE)
      .then((rows) => {
        if (cancelled) return
        absorb(rows ?? [])
        // A full page means there is (probably) more history above; a short one
        // means this is the whole retained conversation.
        setHasEarlier((rows ?? []).length >= PAGE_SIZE)
        setSeeded(true)
      })
      .catch(() => {
        // Main is still booting, or the session isn't tracked yet. Seed empty so
        // the push channel above still delivers whatever arrives later.
        if (!cancelled) setSeeded(true)
      })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [sessionId, absorb])

  const loadEarlier = useCallback(
    async (beforeCommit?: (willPrepend: boolean) => void) => {
      const lowest = messages.length > 0 ? messages[0].seq : null
      if (loadingEarlier || lowest === null) return
      setLoadingEarlier(true)
      try {
        const rows = await window.electronAPI.chatBefore(sessionId, lowest, PAGE_SIZE)
        const page = (rows ?? []).map(toMessage)
        // The page is entirely below our lowest seq, so a uid we don't hold yet
        // is exactly a row that will prepend.
        const held = new Set(messages.map((m) => m.uid))
        beforeCommit?.(page.some((m) => !held.has(m.uid)))
        setMessages((prev) => mergeMessages(prev, page))
        setHasEarlier(page.length >= PAGE_SIZE)
        setEarlierError(false)
      } catch {
        // Keep hasEarlier so the retry pill renders; the auto-loader stands down
        // until the reader taps it.
        setEarlierError(true)
      }
      setLoadingEarlier(false)
    },
    [messages, loadingEarlier, sessionId],
  )

  return { messages, seeded, hasEarlier, loadingEarlier, earlierError, loadEarlier, afterSeq }
}
