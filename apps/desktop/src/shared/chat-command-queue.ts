/** Wire-level chat command semantics shared by the web composer and the desktop host. */
export type ChatQueueCommand = { _id?: string; _creationTime?: number; sessionId?: string; kind?: string; payload?: unknown }

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
