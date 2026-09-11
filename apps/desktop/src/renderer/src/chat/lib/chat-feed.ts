import type { AgentChatLogEvent, AgentChatRow } from '../../../../shared/types'
import { mergeMessages, type ChatBlock, type ChatMessage, type SeqChatMessage } from './chat-messages'

export const PAGE_SIZE = 60

const ROLES: readonly string[] = ['user', 'assistant', 'tool', 'system']

function toMessage(row: AgentChatRow): SeqChatMessage {
  return {
    uid: row.uid,
    seq: row.seq,
    role: ROLES.includes(row.role) ? (row.role as ChatMessage['role']) : 'system',
    blocks: Array.isArray(row.blocks) ? (row.blocks as ChatBlock[]) : [],
    ts: row.ts,
  }
}

export interface ChatFeedSnapshot {
  messages: SeqChatMessage[]
  seeded: boolean
  hasEarlier: boolean
  loadingEarlier: boolean
  earlierError: boolean
  afterSeq: number
}

export interface ChatFeedTransport {
  before: (sessionId: string, beforeSeq: number, limit: number) => Promise<AgentChatRow[]>
  subscribe: (listener: (event: AgentChatLogEvent) => void) => () => void
}

export class ChatFeedController {
  private snapshot: ChatFeedSnapshot = {
    messages: [],
    seeded: false,
    hasEarlier: false,
    loadingEarlier: false,
    earlierError: false,
    afterSeq: -1,
  }
  private readonly listeners = new Set<(snapshot: ChatFeedSnapshot) => void>()
  private unsubscribe: (() => void) | undefined
  private disposed = false
  private started = false
  // Every clear starts a new conversation lifetime. Requests carry the value
  // they started under, so an older response cannot write into the new feed.
  private generation = 0
  // React state is not synchronous enough to guard two calls in one tick.
  private earlierInFlight = false

  constructor(
    private readonly sessionId: string,
    private readonly transport: ChatFeedTransport,
  ) {}

  getSnapshot(): ChatFeedSnapshot {
    return this.snapshot
  }

  subscribe(listener: (snapshot: ChatFeedSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribe = this.transport.subscribe((event) => {
      if (this.disposed || event.sessionId !== this.sessionId) return
      if (event.kind === 'clear') {
        this.generation++
        this.earlierInFlight = false
        this.update({
          messages: [],
          seeded: true,
          hasEarlier: false,
          loadingEarlier: false,
          earlierError: false,
        })
        return
      }
      this.absorb(event.messages)
    })

    const generation = this.generation
    void this.transport
      .before(this.sessionId, Number.MAX_SAFE_INTEGER, PAGE_SIZE)
      .then((rows) => {
        if (!this.isCurrent(generation)) return
        this.absorbSnapshot(rows ?? [])
        this.update({ hasEarlier: (rows ?? []).length >= PAGE_SIZE, seeded: true })
      })
      .catch(() => {
        if (this.isCurrent(generation)) this.update({ seeded: true })
      })
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  async loadEarlier(beforeCommit?: (willPrepend: boolean) => void): Promise<void> {
    const { messages } = this.snapshot
    const lowest = messages.length > 0 ? messages[0].seq : null
    if (this.disposed || this.earlierInFlight || lowest === null) return
    this.earlierInFlight = true
    const generation = this.generation
    this.update({ loadingEarlier: true })
    try {
      const rows = await this.transport.before(this.sessionId, lowest, PAGE_SIZE)
      if (!this.isCurrent(generation)) return
      const page = (rows ?? []).map(toMessage)
      const additions = this.snapshotAdditions(page)
      beforeCommit?.(additions.length > 0)
      this.absorbMessages(additions)
      this.update({ hasEarlier: page.length >= PAGE_SIZE, earlierError: false })
    } catch {
      if (this.isCurrent(generation)) this.update({ earlierError: true })
    }
    if (this.isCurrent(generation)) {
      this.earlierInFlight = false
      this.update({ loadingEarlier: false })
    }
  }

  private absorb(rows: AgentChatRow[]): void {
    this.absorbMessages(rows.map(toMessage))
  }

  private absorbSnapshot(rows: AgentChatRow[]): void {
    this.absorbMessages(this.snapshotAdditions(rows.map(toMessage)))
  }

  /** Snapshots were captured before their promise resolved. They may add rows,
   * but a live push already held for the same uid is authoritative. */
  private snapshotAdditions(incoming: SeqChatMessage[]): SeqChatMessage[] {
    if (incoming.length === 0) return incoming
    const held = new Set(this.snapshot.messages.map((message) => message.uid))
    return incoming.filter((message) => !held.has(message.uid))
  }

  private absorbMessages(incoming: SeqChatMessage[]): void {
    if (incoming.length === 0) return
    const messages = mergeMessages(this.snapshot.messages, incoming)
    const afterSeq = incoming.reduce((highest, message) => Math.max(highest, message.seq), this.snapshot.afterSeq)
    this.update({ messages, afterSeq })
  }

  private update(patch: Partial<ChatFeedSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener(this.snapshot)
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }
}
