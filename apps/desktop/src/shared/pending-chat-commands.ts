/** Pending state belongs to a conversation, not the currently mounted pane. */
export class PendingChatCommands {
  private readonly active = new Map<string, symbol>()
  private readonly listeners = new Map<string, Set<() => void>>()

  has(key: string): boolean { return this.active.has(key) }

  start(key: string): (() => void) | null {
    if (this.active.has(key)) return null
    const id = Symbol(key)
    this.active.set(key, id)
    this.emit(key)
    return () => {
      if (this.active.get(key) !== id) return
      this.active.delete(key)
      this.emit(key)
    }
  }

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.listeners.get(key) ?? new Set()
    listeners.add(listener)
    this.listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(key)
    }
  }

  private emit(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener()
  }
}

export const pendingChatCommands = new PendingChatCommands()
