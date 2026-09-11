/** Wire-level command semantics shared by the backend queue and desktop host. */
export type ChatQueueCommand = { _id: string; _creationTime?: number; sessionId?: string; kind?: string; payload?: unknown }

export function prioritizeCommands<T extends ChatQueueCommand>(ordinary: T[], priority: T[]): T[] {
  const byId = new Map(ordinary.map((command) => [command._id, command]))
  for (const command of priority) byId.set(command._id, command)
  return [...byId.values()].sort((a, b) => (a._creationTime ?? 0) - (b._creationTime ?? 0))
}

export async function cancelPendingChatCommands<T extends ChatQueueCommand>(sessionId: string, deps: {
  list: () => Promise<T[]>
  remove: (id: T['_id']) => Promise<void>
}): Promise<void> {
  for (const command of await deps.list()) {
    if (command.sessionId === sessionId && isChatInput(command)) await deps.remove(command._id)
  }
}

function payloadOf(command: ChatQueueCommand): Record<string, unknown> {
  return typeof command.payload === 'object' && command.payload !== null
    ? command.payload as Record<string, unknown>
    : {}
}

export function isChatInterrupt(command: ChatQueueCommand): boolean {
  const payload = payloadOf(command)
  return command.kind === 'write' && payload.interruptChat === true && payload.data === '\x1b'
}

export function isChatInput(command: ChatQueueCommand): boolean {
  const payload = payloadOf(command)
  return command.kind === 'sendChatMessage'
    || (command.kind === 'write' && payload.steps !== undefined)
    || (command.kind === 'resumeSession' && (payload.text !== undefined || payload.images !== undefined))
}
