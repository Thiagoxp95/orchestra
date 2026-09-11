// In-process store of every tracked session's parsed chat messages — the feed
// the DESKTOP's own chat view reads.
//
// The phone reads the same messages out of Convex (see remote-bridge-messages
// and the agentMessages table). The desktop has no reason to make that round
// trip: it is the process that tails and parses the transcripts in the first
// place. So AgentMessageMirror now writes into this log as well as pushing to
// Convex, and the renderer subscribes to it over IPC. Consequences worth
// stating: the desktop chat works with the remote bridge switched off or the
// network down, and it paints a message as soon as the tailer sees it rather
// than a Convex round trip later.
//
// The shape stored here is deliberately identical to what the web receives
// (`{uid, seq, role, blocks, ts}`), so the entire renderer-side chat model
// (chat-messages.ts, chat-timeline.ts) is shared verbatim between surfaces.

import type { ChatMessage } from './agent-message-model'

/** A parsed message with its position in the session's local message stream. */
export type StoredChatMessage = ChatMessage & { seq: number }

/**
 * Rows kept per session. Matches the backend's cap so the desktop's scrollback
 * window is the same one the phone gets — a conversation that has scrolled out
 * of the log is still in the transcript, and the chat view is a window on the
 * live tail, not an archive.
 */
const CAP = 400

export type ChatLogEvent =
  | { kind: 'append'; sessionId: string; messages: StoredChatMessage[] }
  | { kind: 'clear'; sessionId: string }

export class AgentChatLog {
  private readonly rows = new Map<string, StoredChatMessage[]>()
  private readonly listeners = new Set<(event: ChatLogEvent) => void>()
  // Next seq per session. Held OUTSIDE `rows` and never reset, for the same
  // reason the mirror's ChunkSeq is (see remote-bridge-seq): a mounted ChatPane
  // keeps its cursor across a clear — an untracked/retracked session, an agent
  // swap, a conversation switch — and rows landing at or below that cursor
  // would never be delivered to it again. Primed from the wall clock so the
  // counter also stays above anything handed out before an app restart.
  private readonly nextSeq = new Map<string, number>()

  /** Subscribe to appends/clears. Returns an unsubscribe. */
  subscribe(listener: (event: ChatLogEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: ChatLogEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('[chat-log] listener failed', err)
      }
    }
  }

  private allocate(sessionId: string): number {
    const seq = this.nextSeq.get(sessionId) ?? Date.now()
    this.nextSeq.set(sessionId, seq + 1)
    return seq
  }

  /**
   * Record newly parsed messages. Upserts by uid and KEEPS the stored seq on a
   * patch, exactly like the backend's appendMessages — a re-attach replays the
   * same records, and re-stamping them would shuffle the conversation.
   *
   * A patched row is emitted along with the new ones even though it sits below
   * every reader's cursor: renderer-side merging is by uid, so a listener that
   * already holds the row simply updates it in place (the web, whose live tail
   * is a seq-greater-than query, cannot do this — hence the `unqueued`/`reset`
   * marker rows the parser emits instead of editing history).
   */
  append(sessionId: string, messages: ChatMessage[]): StoredChatMessage[] {
    if (messages.length === 0) return []
    const held = this.rows.get(sessionId) ?? []
    const byUid = new Map(held.map((m) => [m.uid, m]))
    const indexByUid = new Map(held.map((m, index) => [m.uid, index]))
    const emitted: StoredChatMessage[] = []
    let appended = false
    for (const message of messages) {
      const existing = byUid.get(message.uid)
      if (existing) {
        const updated: StoredChatMessage = { ...message, seq: existing.seq }
        held[indexByUid.get(updated.uid)!] = updated
        byUid.set(updated.uid, updated)
        emitted.push(updated)
        continue
      }
      const stored: StoredChatMessage = { ...message, seq: this.allocate(sessionId) }
      byUid.set(stored.uid, stored)
      indexByUid.set(stored.uid, held.length)
      held.push(stored)
      emitted.push(stored)
      appended = true
    }
    if (appended && held.length > CAP) held.splice(0, held.length - CAP)
    this.rows.set(sessionId, held)
    this.emit({ kind: 'append', sessionId, messages: emitted })
    return emitted
  }

  /**
   * Drop a session's conversation: the transcript swapped to a different one, or
   * the session stopped running an agent. The seq counter survives on purpose.
   */
  clear(sessionId: string): void {
    if (!this.rows.has(sessionId)) return
    this.rows.delete(sessionId)
    this.emit({ kind: 'clear', sessionId })
  }

  /** Rows above `afterSeq`, oldest first. The live tail. */
  since(sessionId: string, afterSeq: number): StoredChatMessage[] {
    const held = this.rows.get(sessionId)
    if (!held) return []
    return held.filter((m) => m.seq > afterSeq)
  }

  /** The `limit` newest rows below `beforeSeq`, oldest first. History paging. */
  before(sessionId: string, beforeSeq: number, limit: number): StoredChatMessage[] {
    const held = this.rows.get(sessionId)
    if (!held) return []
    const older = held.filter((m) => m.seq < beforeSeq)
    return older.slice(Math.max(0, older.length - limit))
  }
}

/** The app-wide log. Created eagerly: it holds nothing until the mirror feeds it. */
export const agentChatLog = new AgentChatLog()
