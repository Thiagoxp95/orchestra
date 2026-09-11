import { isChatInput, isChatInterrupt, type ChatQueueCommand as Command } from '../shared/chat-command-queue'

export class RemoteChatInterrupts {
  private readonly observed = new Set<string>()
  private readonly cancelled = new Set<string>()
  private readonly stoppedThrough = new Map<string, number>()
  constructor(private readonly interrupt: (sessionId: string) => void, private readonly onError: (error: unknown) => void = () => {}) {}

  /** Runs at subscription delivery, outside the ordinary command backlog. */
  observe(commands: Command[]): void {
    const pending = new Set(commands.map((cmd) => cmd._id))
    for (const id of this.observed) if (!pending.has(id)) this.observed.delete(id)
    const earlier = new Map<string, string[]>()
    for (const cmd of commands) {
      if (!cmd.sessionId) continue
      if (isChatInterrupt(cmd)) {
        if (cmd._creationTime !== undefined) {
          this.stoppedThrough.set(cmd.sessionId, Math.max(this.stoppedThrough.get(cmd.sessionId) ?? -Infinity, cmd._creationTime))
        }
        for (const id of earlier.get(cmd.sessionId) ?? []) this.cancelled.add(id)
        if (this.observed.has(cmd._id)) continue
        this.observed.add(cmd._id)
        try { this.interrupt(cmd.sessionId) } catch (error) { this.onError(error) }
      } else if (isChatInput(cmd)) {
        const ids = earlier.get(cmd.sessionId) ?? []
        ids.push(cmd._id)
        earlier.set(cmd.sessionId, ids)
      }
    }
  }

  shouldApply(command: Command): boolean {
    const cutoff = command.sessionId ? this.stoppedThrough.get(command.sessionId) : undefined
    const stopped = isChatInput(command) && cutoff !== undefined
      && command._creationTime !== undefined && command._creationTime < cutoff
    return !isChatInterrupt(command) && !this.cancelled.has(command._id) && !stopped
  }

  /** Called after the command drain has applied/skipped and acknowledged it. */
  acknowledged(id: string): void { this.cancelled.delete(id) }
}
