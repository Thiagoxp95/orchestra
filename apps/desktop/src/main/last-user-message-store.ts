// apps/desktop/src/main/last-user-message-store.ts
export interface LastUserMessageEntry {
  sessionId: string
  text: string
  timestamp: number
}

type Handler = (entry: LastUserMessageEntry) => void

const entries = new Map<string, LastUserMessageEntry>()
const handlers = new Set<Handler>()

export function setLastUserMessage(sessionId: string, text: string): void {
  if (!text) return
  const existing = entries.get(sessionId)
  if (existing && existing.text === text) return
  const entry: LastUserMessageEntry = { sessionId, text, timestamp: Date.now() }
  entries.set(sessionId, entry)
  for (const h of handlers) h(entry)
}

export function getLastUserMessage(sessionId: string): LastUserMessageEntry | undefined {
  return entries.get(sessionId)
}

export function clearSession(sessionId: string): void {
  entries.delete(sessionId)
}

export function subscribe(handler: Handler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

export function __resetForTests(): void {
  entries.clear()
  handlers.clear()
}
