import { createHash } from 'node:crypto'
import { ChatInputController } from '../chat-input-controller'
import type { ChatMessage } from '../agent-message-model'
import { isNativeChatWorking, type NativeChatCommand, type NativeChatProvider, type NativeChatSnapshot } from '../../shared/native-chat'
import type { NativeChatAdapter, ProviderEvent, ProviderEventSink } from './provider'
type Receipt = { id: string; fingerprint: string; status: 'pending' | 'accepted' | 'failed'; error?: string }
export type NativeChatRecord = { snapshot: NativeChatSnapshot; history: ChatMessage[]; receipts: Receipt[] }
type Descriptor = Pick<NativeChatSnapshot, 'sessionId' | 'provider' | 'cwd' | 'conversationId' | 'settings'>
type Owner = { adapter: NativeChatAdapter; generation: symbol; opening?: Promise<void> }
type Options = { load(): NativeChatRecord[]; save(record: NativeChatRecord): void; factory(provider: NativeChatProvider, emit: ProviderEventSink): NativeChatAdapter; onMessages?(sessionId: string, messages: ChatMessage[]): void }
/** Owns durable chat state; adapters own only their current provider connection. */
export class NativeChatManager {
  private readonly records = new Map<string, NativeChatRecord>()
  private readonly owners = new Map<string, Owner>()
  private readonly listeners = new Set<(snapshot: NativeChatSnapshot) => void>()
  private readonly queue = new ChatInputController()
  private readonly closing = new Map<string, Promise<void>>()
  private readonly interrupting = new Map<string, Promise<void>>()
  private readonly historyTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly runningCommands = new Map<string, Promise<NativeChatSnapshot>>()
  constructor(private readonly options: Options) {
    for (const record of options.load()) {
      const snapshot = { ...record.snapshot, status: 'stopped' as const, requests: [], revision: record.snapshot.revision + 1 }
      this.records.set(snapshot.sessionId, { ...record, snapshot })
    }
  }
  get(sessionId: string): NativeChatSnapshot | null { return this.records.get(sessionId)?.snapshot ?? null }
  all(): NativeChatSnapshot[] { return [...this.records.values()].map(r => r.snapshot) }
  history(sessionId: string): ChatMessage[] { return this.records.get(sessionId)?.history ?? [] }
  subscribe(listener: (snapshot: NativeChatSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  register(descriptor: Descriptor, history: ChatMessage[] = []): NativeChatSnapshot {
    const existing = this.get(descriptor.sessionId)
    if (existing) return existing
    const snapshot: NativeChatSnapshot = { ...descriptor, settings: { ...descriptor.settings }, status: 'stopped', requests: [], revision: 1 }
    const record: NativeChatRecord = { snapshot, history: history.slice(-400), receipts: [] }
    this.options.save(record)
    this.records.set(snapshot.sessionId, record)
    this.publish(snapshot)
    if (record.history.length) this.options.onMessages?.(snapshot.sessionId, record.history)
    return snapshot
  }
  replayCommand(sessionId: string, id: string, fingerprint: string): Promise<NativeChatSnapshot> | null {
    const record = this.records.get(sessionId)
    const receipt = record?.receipts.find(r => r.id === id)
    if (!record || !receipt) return null
    const hash = createHash('sha256').update(fingerprint).digest('hex')
    if (receipt.fingerprint !== hash) return Promise.reject(new Error('Command id reused with different input'))
    const running = this.runningCommands.get(`${sessionId}:${id}`)
    if (running) return running
    if (receipt.status === 'accepted') return Promise.resolve(record.snapshot)
    return Promise.reject(new Error(receipt.error ?? 'Previous command outcome is unknown after restart; inspect the conversation before sending again'))
  }
  execute(sessionId: string, command: NativeChatCommand, operationId?: string, operationFingerprint?: string): Promise<NativeChatSnapshot> {
    const record = this.records.get(sessionId)
    if (!record) return Promise.reject(new Error('Start native chat for this session first'))
    const fingerprint = createHash('sha256').update(operationFingerprint ?? JSON.stringify(command)).digest('hex')
    const key = operationId ? `${sessionId}:${operationId}` : undefined
    if (operationId) {
      const receipt = record.receipts.find(r => r.id === operationId)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) return Promise.reject(new Error('Command id reused with different input'))
        const running = this.runningCommands.get(key!)
        if (running) return running
        if (receipt.status === 'accepted') return Promise.resolve(record.snapshot)
        return Promise.reject(new Error(receipt.error ?? 'Previous command outcome is unknown after restart; inspect the conversation before sending again'))
      }
      record.receipts.push({ id: operationId, fingerprint, status: 'pending' })
      try { this.persist(sessionId) } catch (error) { record.receipts = record.receipts.filter(r => r.id !== operationId); return Promise.reject(error) }
    }
    const run = async (): Promise<NativeChatSnapshot> => {
      try {
        if (command.kind === 'interrupt') await this.interrupt(sessionId)
        else {
          if (command.kind === 'send' && command.steer) await this.interrupt(sessionId)
          await this.queue.run(sessionId, async check => {
            await this.interrupting.get(sessionId)
            check()
            await this.ensureOpen(sessionId)
            check()
            const owner = this.owners.get(sessionId)!
            const snapshot = this.get(sessionId)!
            if (command.kind === 'start') return
            if (command.kind === 'respond') {
              if (!snapshot.requests.some(r => r.id === command.reply.requestId)) throw new Error('This request is no longer pending')
              await owner.adapter.respond(command.reply)
              return
            }
            if (isNativeChatWorking(snapshot.status)) throw new Error('Agent is busy. Stop the current turn before changing settings or sending another message')
            if (command.kind === 'configure') {
              const settings = { ...snapshot.settings, ...command.settings }
              await owner.adapter.configure(settings)
              try {
                check()
                this.update(sessionId, { settings, error: undefined })
              } catch (error) {
                // Provider acceptance and durable selection are one operation.
                // If saving/cancellation fails after acceptance, restore the
                // last accepted settings before this owner can serve a turn.
                try { await owner.adapter.configure(snapshot.settings) }
                catch { this.retireOwner(sessionId) }
                throw error
              }
            } else if (command.kind === 'compact') await owner.adapter.compact()
            else if (command.kind === 'send') {
              if (!command.text.trim() && !command.images?.length) throw new Error('Message is empty')
              await owner.adapter.send({ text: command.text, images: command.images ?? [], settings: snapshot.settings })
            }
            check()
          })
        }
        this.finishReceipt(sessionId, operationId, 'accepted')
        return this.get(sessionId)!
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.finishReceipt(sessionId, operationId, 'failed', message)
        this.update(sessionId, { error: message })
        throw error
      }
    }
    const result = run().finally(() => { if (key) this.runningCommands.delete(key) })
    if (key) this.runningCommands.set(key, result)
    return result
  }
  private async ensureOpen(sessionId: string): Promise<void> {
    await this.closing.get(sessionId)
    const existing = this.owners.get(sessionId)
    if (existing) { await existing.opening; return }
    const snapshot = this.get(sessionId)!
    if (snapshot.conversationId) {
      for (const otherId of this.owners.keys()) {
        const other = this.get(otherId)
        if (otherId !== sessionId && other?.provider === snapshot.provider && other.conversationId === snapshot.conversationId) throw new Error('This conversation is already open in another native session')
      }
    }
    this.update(sessionId, { status: 'starting', error: undefined, requests: [] })
    const generation = Symbol(sessionId)
    const adapter = this.options.factory(snapshot.provider, event => {
      if (this.owners.get(sessionId)?.generation !== generation) return
      try { this.event(sessionId, event) }
      catch (error) {
        const record = this.records.get(sessionId)!
        record.snapshot = { ...record.snapshot, status: 'error', error: `Could not persist native chat: ${String(error)}`, revision: record.snapshot.revision + 1 }
        this.publish(record.snapshot)
        this.retireOwner(sessionId)
      }
    })
    const owner: Owner = { adapter, generation }
    this.owners.set(sessionId, owner)
    const opening = adapter.open({ cwd: snapshot.cwd, conversationId: snapshot.conversationId, settings: snapshot.settings })
    owner.opening = opening
    try {
      await opening
      if (this.owners.get(sessionId) !== owner) throw new Error('Chat startup cancelled')
      owner.opening = undefined
      if (this.get(sessionId)!.status === 'starting') this.update(sessionId, { status: 'idle' })
    } catch (error) {
      if (this.owners.get(sessionId) === owner) {
        this.owners.delete(sessionId)
        await adapter.close().catch(() => {})
        this.update(sessionId, { status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
      throw error
    }
  }
  private interrupt(sessionId: string): Promise<void> {
    this.queue.cancel(sessionId)
    const existing = this.interrupting.get(sessionId)
    if (existing) return existing
    const pending = (async () => {
      const owner = this.owners.get(sessionId)
      if (owner?.opening) {
        this.owners.delete(sessionId)
        await owner.adapter.close()
        this.update(sessionId, { status: 'stopped', requests: [], error: undefined })
      } else if (owner) {
        await owner.adapter.interrupt()
        this.update(sessionId, { status: 'idle', requests: [], error: undefined })
      }
    })().finally(() => { this.interrupting.delete(sessionId) })
    this.interrupting.set(sessionId, pending)
    return pending
  }
  async stop(sessionId: string): Promise<void> {
    this.queue.cancel(sessionId)
    const owner = this.owners.get(sessionId)
    this.owners.delete(sessionId)
    await owner?.adapter.close()
    if (this.records.has(sessionId)) this.update(sessionId, { status: 'stopped', requests: [] })
  }
  async close(): Promise<void> {
    this.flush()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled([...this.owners.keys()].map(id => this.stop(id))),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 5000) }),
      ])
    } finally { if (timer) clearTimeout(timer); this.flush() }
  }
  private retireOwner(sessionId: string): void {
    const owner = this.owners.get(sessionId)
    if (!owner) return
    this.owners.delete(sessionId)
    const closing = owner.adapter.close().catch(() => {}).finally(() => { if (this.closing.get(sessionId) === closing) this.closing.delete(sessionId) })
    this.closing.set(sessionId, closing)
  }
  flush(): void { for (const [id, timer] of this.historyTimers) { clearTimeout(timer); this.persist(id) }; this.historyTimers.clear() }
  private event(sessionId: string, event: ProviderEvent): void {
    switch (event.kind) {
      case 'settings': this.update(sessionId, { settings: event.settings }); break
      case 'catalog': this.update(sessionId, { models: event.models }); break
      case 'conversation': this.update(sessionId, { conversationId: event.conversationId }); break
      case 'status':
        this.update(sessionId, { status: event.status, error: event.error, ...(event.status === 'idle' || event.status === 'error' ? { requests: [] } : {}) })
        if (event.status === 'error') this.retireOwner(sessionId)
        break
      case 'request': this.update(sessionId, { status: 'waiting', requests: [...this.get(sessionId)!.requests.filter(r => r.id !== event.request.id), event.request] }); break
      case 'request-resolved': {
        const requests = this.get(sessionId)!.requests.filter(r => r.id !== event.requestId)
        this.update(sessionId, { requests, ...(requests.length === 0 ? { status: 'working' as const } : {}) })
        break
      }
      case 'messages': {
        const record = this.records.get(sessionId)!
        const rows = new Map(record.history.map(m => [m.uid, m]))
        for (const message of event.messages) rows.set(message.uid, message)
        record.history = [...rows.values()].slice(-400)
        this.options.onMessages?.(sessionId, event.messages)
        if (!this.historyTimers.has(sessionId)) {
          const timer = setTimeout(() => {
            this.historyTimers.delete(sessionId)
            try { this.persist(sessionId) } catch (error) { this.publish({ ...record.snapshot, error: `Could not save chat history: ${String(error)}` }) }
          }, 150)
          timer.unref?.()
          this.historyTimers.set(sessionId, timer)
        }
      }
    }
  }
  private finishReceipt(sessionId: string, id: string | undefined, status: Receipt['status'], error?: string): void {
    if (!id) return
    const receipt = this.records.get(sessionId)!.receipts.find(r => r.id === id)!
    Object.assign(receipt, { status, ...(error ? { error } : {}) })
    this.persist(sessionId)
  }
  private update(sessionId: string, patch: Partial<NativeChatSnapshot>): void {
    const record = this.records.get(sessionId)!
    const before = record.snapshot
    record.snapshot = { ...before, ...patch, revision: before.revision + 1 }
    try { this.persist(sessionId) } catch (error) { record.snapshot = before; throw error }
    this.publish(record.snapshot)
  }
  private persist(sessionId: string): void { this.options.save(this.records.get(sessionId)!) }
  private publish(snapshot: NativeChatSnapshot): void { for (const listener of this.listeners) listener(snapshot) }
}
